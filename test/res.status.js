
var express = require('../')
  , res = require('../lib/response')
  , request = require('supertest')
  , assert = require('assert');

describe('res', function(){
  describe('.status(code)', function(){
    it('should set the response .statusCode', function(done){
      var app = express();

      app.use(function(req, res){
        res.status(201).end('Created');
      });

      request(app)
      .get('/')
      .expect('Created')
      .expect(201, done);
    })
    it('should throw if code is a string', function(done) {
      assert.throws(function () {
        res.status('')
      }, new TypeError('Invalid status code'), 'for case empty string')
      assert.throws(function () {
        res.status('200')
      }, new TypeError('Invalid status code'), 'for case "200"')
      done()
    })

    it('should throw on invalid status codes', function (done) {
      var cases = [
        200.1,
        99,
        1000,
        NaN,
        Infinity,
        -Infinity,
        undefined,
        null,
        function () {},
        true,
        false,
        {},
        [],
      ]
      cases.forEach(function (item) {
        assert.throws(function () {
          res.status(item)
        }, new TypeError('Invalid status code'))
      })
      done()
    })
  })
})
