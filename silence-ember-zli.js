// our tool writes a valid (P)CAP stream to stdout, however ember-zli
// uses winston for logging, which pollutes stdout with log messages.
// to avoid that, we patch winston used by ember-zli to use a null transport.
import { createRequire } from 'module';

// resolve ember-zli's main file from *this* module
const requireHere = createRequire(import.meta.url);
const emberZliPath = requireHere.resolve('ember-zli');

// require from ember-zli's location
const requireFromEmberZli = createRequire(emberZliPath);
const winston = requireFromEmberZli('winston');

const debugLog = process.argv.includes('-vvv');

// patch winston used by ember-zli
if (!debugLog && winston.transports.Console) {
    const ConsoleTransport = winston.transports.Console;
    ConsoleTransport.prototype.log = function (info, cb) {
        typeof cb === 'function' && cb();
    };
}

if (winston.transports.File) {
    const FileTransport = winston.transports.File;
    FileTransport.prototype.log = function (info, cb) {
        typeof cb === 'function' && cb();
    };
}
