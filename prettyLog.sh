#!/bin/bash

 git log 4.17.1...5.0.0-alpha.8 --no-merges --pretty=format:'* [%s](http://github.com/expressjs/express/commit/%H)'
