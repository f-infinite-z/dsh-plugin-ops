#!/usr/bin/env node

const [, , ...args] = process.argv
process.stdout.write(`dsh-ops scaffold: ${args.join(' ')}\n`)
