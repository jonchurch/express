'use strict'

const contentDisposition = require('content-disposition')
const createError        = require('http-errors')
const encodeUrl          = require('encodeurl')
const escapeHtml         = require('escape-html')
const http               = require('node:http')
const onFinished         = require('on-finished')
const mime               = require('mime-types')
const path               = require('node:path')
const pathIsAbsolute     = path.isAbsolute
const statuses           = require('statuses')
const { sign }           = require('cookie-signature')

const {
  normalizeType,
  normalizeTypes,
  setCharset
} = require('./utils')

const cookie   = require('cookie')
const send     = require('send')
const extname  = path.extname
const resolve  = path.resolve
const vary     = require('vary')

class ExpressResponse extends http.ServerResponse {

  /**  Set status code.  */
  status (code) {
    if (!Number.isInteger(code)) {
      throw new TypeError(
        `Invalid status code: ${JSON.stringify(code)}. Must be integer.`
      )
    }
    if (code < 100 || code > 999) {
      throw new RangeError(
        `Invalid status code: ${JSON.stringify(code)}. Must be 100-999.`
      )
    }
    this.statusCode = code
    return this
  }

  /**  Add Link header.  */
  links (links) {
    let link = this.get('Link') || ''
    if (link) link += ', '
    return this.set(
      'Link',
      link +
        Object.keys(links)
          .map((rel) =>
            Array.isArray(links[rel])
              ? links[rel]
                  .map((l) => `<${l}>; rel="${rel}"`)
                  .join(', ')
              : `<${links[rel]}>; rel="${rel}"`
          )
          .join(', ')
    )
  }

  /**  Generic body sender.  */
  send (body) {
    let chunk   = body
    let enc
    const req   = this.req
    const app   = this.app
    let type

    /* -- normalise body & Content-Type --------------------------- */
    switch (typeof chunk) {
      case 'string':
        if (!this.get('Content-Type')) this.type('html')
        break
      case 'boolean':
      case 'number':
      case 'object':
        if (chunk === null) {
          chunk = ''
        } else if (ArrayBuffer.isView(chunk)) {
          if (!this.get('Content-Type')) this.type('bin')
        } else {
          return this.json(chunk)
        }
        break
    }

    /* -- encode strings as utf-8 --------------------------------- */
    if (typeof chunk === 'string') {
      enc  = 'utf8'
      type = this.get('Content-Type')
      if (typeof type === 'string') this.set('Content-Type', setCharset(type, 'utf-8'))
    }

    /* -- compute Content-Length / ETag ---------------------------- */
    const etagFn      = app.get('etag fn')
    const genETag     = !this.get('ETag') && typeof etagFn === 'function'
    let len

    if (chunk !== undefined) {
      if (Buffer.isBuffer(chunk)) {
        len = chunk.length
      } else if (!genETag && chunk.length < 1000) {
        len = Buffer.byteLength(chunk, enc)
      } else {
        chunk = Buffer.from(chunk, enc)
        enc   = undefined
        len   = chunk.length
      }
      this.set('Content-Length', len)
    }

    if (genETag && len !== undefined) {
      const tag = etagFn(chunk, enc)
      if (tag) this.set('ETag', tag)
    }

    /* -- freshness / 304 / 204 handling -------------------------- */
    if (req.fresh) this.status(304)

    if (this.statusCode === 204 || this.statusCode === 304) {
      this.removeHeader('Content-Type')
      this.removeHeader('Content-Length')
      this.removeHeader('Transfer-Encoding')
      chunk = ''
    }
    if (this.statusCode === 205) {
      this.set('Content-Length', '0')
      this.removeHeader('Transfer-Encoding')
      chunk = ''
    }

    /* -- HEAD shortcut ------------------------------------------- */
    if (req.method === 'HEAD') {
      this.end()
    } else {
      this.end(chunk, enc)
    }

    return this
  }

  /**  JSON shorthand.  */
  json (obj) {
    const app     = this.app
    const escape  = app.get('json escape')
    const replac  = app.get('json replacer')
    const spaces  = app.get('json spaces')
    const body    = stringify(obj, replac, spaces, escape)

    if (!this.get('Content-Type')) this.set('Content-Type', 'application/json')
    return this.send(body)
  }

  /**  JSONP helper.  */
  jsonp (obj) {
    const app      = this.app
    const escape   = app.get('json escape')
    const replacer = app.get('json replacer')
    const spaces   = app.get('json spaces')
    let body       = stringify(obj, replacer, spaces, escape)
    let cb         = this.req.query[app.get('jsonp callback name')]

    if (!this.get('Content-Type')) {
      this.set('X-Content-Type-Options', 'nosniff')
      this.set('Content-Type', 'application/json')
    }

    if (Array.isArray(cb)) cb = cb[0]
    if (typeof cb === 'string' && cb.length !== 0) {
      this.set('X-Content-Type-Options', 'nosniff')
      this.set('Content-Type', 'text/javascript')
      cb = cb.replace(/[^\[\]\w$.]/g, '')
      if (body === undefined) body = ''
      else if (typeof body === 'string') {
        body = body.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
      }
      body = `/**/ typeof ${cb}==='function'&&${cb}(${body});`
    }

    return this.send(body)
  }

  /**  Shorthand status-only sender.  */
  sendStatus (statusCode) {
    const body = statuses.message[statusCode] || String(statusCode)
    this.status(statusCode).type('txt')
    return this.send(body)
  }

  /**  sendFile wrapper around `send`.  */
  sendFile (filePath, options, cb) {
    let done = cb
    let opts = options || {}
    const req  = this.req
    const next = req.next

    if (!filePath) throw new TypeError('path argument is required to res.sendFile')
    if (typeof filePath !== 'string') throw new TypeError('path must be a string to res.sendFile')

    if (typeof options === 'function') {
      done = options
      opts = {}
    }

    if (!opts.root && !pathIsAbsolute(filePath)) {
      throw new TypeError('path must be absolute or specify root to res.sendFile')
    }

    const pathname = encodeURI(filePath)
    opts.etag      = this.app.enabled('etag')

    const stream = send(req, pathname, opts)

    sendfile(this, stream, opts, (err) => {
      if (done) return done(err)
      if (err && err.code === 'EISDIR') return next()
      if (err && err.code !== 'ECONNABORTED' && err.syscall !== 'write') next(err)
    })
  }

  /**  Attachment helper.  */
  download (filePath, filename, options, callback) {
    let done  = callback
    let name  = filename
    let opts  = options || null

    if (typeof filename === 'function') {
      done = filename
      name = null
      opts = null
    } else if (typeof options === 'function') {
      done = options
      opts = null
    }

    if (typeof filename === 'object' &&
        (typeof options === 'function' || options === undefined)) {
      name = null
      opts = filename
    }

    const headers = { 'Content-Disposition': contentDisposition(name || filePath) }
    if (opts && opts.headers) {
      for (const k of Object.keys(opts.headers)) {
        if (k.toLowerCase() !== 'content-disposition') headers[k] = opts.headers[k]
      }
    }

    opts         = Object.create(opts || null)
    opts.headers = headers

    const fullPath = !opts.root ? resolve(filePath) : filePath
    return this.sendFile(fullPath, opts, done)
  }

  /**  `res.type()` / `res.contentType()`  */
  contentType (type) { return this.type(type) }
  type (t) {
    const ct = t.indexOf('/') === -1 ? mime.contentType(t) || 'application/octet-stream' : t
    return this.set('Content-Type', ct)
  }

  /**  Request content negotiation.  */
  format (obj) {
    const req  = this.req
    const next = req.next
    const keys = Object.keys(obj).filter((v) => v !== 'default')
    const key  = keys.length ? req.accepts(keys) : false

    this.vary('Accept')

    if (key) {
      this.set('Content-Type', normalizeType(key).value)
      obj[key](req, this, next)
    } else if (obj.default) {
      obj.default(req, this, next)
    } else {
      next(
        createError(406, {
          types: normalizeTypes(keys).map((o) => o.value)
        })
      )
    }
    return this
  }

  /**  Content-Disposition attachment helper. */
  attachment (filename) {
    if (filename) this.type(extname(filename))
    this.set('Content-Disposition', contentDisposition(filename))
    return this
  }

  /**  Append header value(s).  */
  append (field, val) {
    const prev  = this.get(field)
    let value   = val
    if (prev) {
      value = Array.isArray(prev)
        ? prev.concat(val)
        : Array.isArray(val)
          ? [prev].concat(val)
          : [prev, val]
    }
    return this.set(field, value)
  }

  /**  Set header(s).  */
  set (field, val) { return this.header(field, val) }
  header (field, val) {
    if (arguments.length === 2) {
      let value = Array.isArray(val) ? val.map(String) : String(val)
      if (field.toLowerCase() === 'content-type') {
        if (Array.isArray(value)) throw new TypeError('Content-Type cannot be an array')
        value = mime.contentType(value)
      }
      this.setHeader(field, value)
    } else {
      for (const k in field) this.set(k, field[k])
    }
    return this
  }

  /**  Retrieve header.  */
  get (field) { return this.getHeader(field) }

  /**  Clear cookie.  */
  clearCookie (name, options) {
    const opts = { path: '/', ...options, expires: new Date(1) }
    delete opts.maxAge
    return this.cookie(name, '', opts)
  }

  /**  Set cookie.  */
  cookie (name, value, options) {
    const opts    = { ...options }
    const secret  = this.req.secret
    const signed  = opts.signed

    if (signed && !secret) throw new Error('cookieParser("secret") required for signed cookies')

    let val = typeof value === 'object' ? 'j:' + JSON.stringify(value) : String(value)
    if (signed) val = 's:' + sign(val, secret)

    if (opts.maxAge != null) {
      const maxAge = opts.maxAge - 0
      if (!isNaN(maxAge)) {
        opts.expires = new Date(Date.now() + maxAge)
        opts.maxAge  = Math.floor(maxAge / 1000)
      }
    }
    if (opts.path == null) opts.path = '/'
    this.append('Set-Cookie', cookie.serialize(name, String(val), opts))
    return this
  }

  /**  Set Location header (with encode).  */
  location (url) { return this.set('Location', encodeUrl(url)) }

  /**  Redirect helper.  */
  redirect (url) {
    let address = url
    let status  = 302
    let body

    if (arguments.length === 2) {
      status  = arguments[0]
      address = arguments[1]
    }

    address = this.location(address).get('Location')

    this.format({
      text: () => { body = `${statuses.message[status]}. Redirecting to ${address}` },
      html: () => {
        const u = escapeHtml(address)
        body = `<p>${statuses.message[status]}. Redirecting to ${u}</p>`
      },
      default: () => { body = '' }
    })

    this.status(status).set('Content-Length', Buffer.byteLength(body))
    return this.req.method === 'HEAD' ? this.end() : this.end(body)
  }

  /**  Add to Vary header. */
  vary (field) { vary(this, field); return this }

  /**  View rendering sugar.  */
  render (view, options, callback) {
    const app = this.req.app
    let opts  = options || {}
    let done  = callback

    if (typeof options === 'function') {
      done = options
      opts = {}
    }

    opts._locals = this.locals

    done =
      done ||
      ((err, str) => {
        if (err) return this.req.next(err)
        this.send(str)
      })

    app.render(view, opts, done)
  }
}

/*  Pipe the send-file stream.  */
function sendfile (res, file, options, callback) {
  let done = false
  let streaming

  function onaborted () {
    if (done) return
    done = true
    const err = new Error('Request aborted')
    err.code = 'ECONNABORTED'
    callback(err)
  }

  function ondirectory () {
    if (done) return
    done = true
    const err = new Error('EISDIR, read')
    err.code = 'EISDIR'
    callback(err)
  }

  function onerror (err) {
    if (done) return
    done = true
    callback(err)
  }

  function onend () {
    if (done) return
    done = true
    callback()
  }

  function onfile () { streaming = false }
  function onstream () { streaming = true }

  function onfinish (err) {
    if (err && err.code === 'ECONNRESET') return onaborted()
    if (err) return onerror(err)
    if (done) return

    setImmediate(() => {
      if (streaming !== false && !done) onaborted()
      else if (!done) {
        done = true
        callback()
      }
    })
  }

  file.on('directory', ondirectory)
  file.on('end', onend)
  file.on('error', onerror)
  file.on('file', onfile)
  file.on('stream', onstream)
  onFinished(res, onfinish)

  if (options.headers) {
    file.on('headers', (res) => {
      for (const k of Object.keys(options.headers)) res.setHeader(k, options.headers[k])
    })
  }

  file.pipe(res)
}

/*  Faster / escapable JSON stringify.  */
function stringify (value, replacer, spaces, escape) {
  let json =
    replacer || spaces ? JSON.stringify(value, replacer, spaces) : JSON.stringify(value)

  if (escape && typeof json === 'string') {
    json = json.replace(/[<>&]/g, (c) => {
      switch (c.charCodeAt(0)) {
        case 0x3c: return '\\u003c'
        case 0x3e: return '\\u003e'
        case 0x26: return '\\u0026'
        default:   return c
      }
    })
  }
  return json
}

module.exports = ExpressResponse
