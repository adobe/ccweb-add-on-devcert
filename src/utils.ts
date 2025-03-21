import { execFileSync, ExecFileSyncOptions } from 'child_process';
import tmp from 'tmp';
import createDebug from 'debug';
import path from 'path';
import sudoPrompt from 'sudo-prompt';

import { configPath } from './constants';

const debug = createDebug('devcert:util');

export function openssl(args: string[]) {
  return run('openssl', args, {
    stdio: 'pipe',
    env: Object.assign({
      RANDFILE: path.join(configPath('.rnd'))
    }, process.env)
  });
}

export function run(cmd: string, args: string[], options: ExecFileSyncOptions = {}) {
  debug(`execFileSync: \`${ cmd } ${args.join(' ')}\``);
  return execFileSync(cmd, args, options);
}

export function sudoAppend(file: string, input: ExecFileSyncOptions["input"]) {
  run('sudo', ['tee', '-a', file], {
    input
  });
}

export function waitForUser() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.on('data', resolve);
  });
}

export function reportableError(message: string) {
  return new Error(`${message} | This is a bug in devcert, please report the issue at https://github.com/davewasmer/devcert/issues`);
}

export function mktmp() {
  // discardDescriptor because windows complains the file is in use if we create a tmp file
  // and then shell out to a process that tries to use it
  return tmp.fileSync({ discardDescriptor: true }).name;
}

export function sudo(cmd: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    sudoPrompt.exec(cmd, { name: 'devcert' }, (err: Error | null, stdout: string | null, stderr: string | null) => {
      let error = err || (typeof stderr === 'string' && stderr.trim().length > 0 && new Error(stderr)) ;
      error ? reject(error) : resolve(stdout);
    });
  });
}

export const numericHash = (str: string): number => {
  let hash = 5381;
  let i = str.length;

  while (i) {
    hash = hash * 33 ^ str.charCodeAt(--i);
  }

  return hash >>> 0;
};

export function parseOpenSSLExpiryData(data: string): number {
  if (data === '') {
    return -1;
  }

  const resultContents = data.split('=');
  if (resultContents.length !== 2) {
    return -1;
  }

  const expiryString = resultContents[1];
  const expiry = new Date(expiryString);
  
  const expiryEpoch = expiry.getTime();
  const nowEpoch = new Date().getTime();
  return Math.floor((expiryEpoch - nowEpoch) / 86400000); // ms to days
}
