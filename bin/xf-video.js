#!/usr/bin/env node
'use strict';

const { main } = require('../src/cli');
const { publicError } = require('../src/utils/redact');

main(process.argv.slice(2)).then(
  code => { process.exitCode = code; },
  error => {
    console.error(`xfv: ${publicError(error)}`);
    process.exitCode = 1;
  },
);
