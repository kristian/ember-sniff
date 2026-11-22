#!/usr/bin/env node
import './silence-ember-zli.js';
import { createWriteStream } from 'node:fs';
import { exit } from 'node:process';

import { createRequire } from 'module';
const requireHere = createRequire(import.meta.url);
const emberZliPath = requireHere.resolve('ember-zli');
const requireFromEmberZli = createRequire(emberZliPath);

const setLogger = requireFromEmberZli('zigbee-herdsman').setLogger;
const { SLStatus, EzspStatus } = requireFromEmberZli('zigbee-herdsman/dist/adapter/ember/enums.js');
const { AdapterTransport } = requireFromEmberZli("zigbee-herdsman/dist/adapter/transport.js");
import { createPcapFileHeader as createPcapHeader, createPcapPacketRecordMs, PCAP_MAGIC_NUMBER_MS } from 'ember-zli/dist/utils/wireshark.js';

import { emberStart, emberStop } from 'ember-zli/dist/utils/ember.js';
import { computeCRC16CITTKermit } from 'ember-zli/dist/utils/utils.js';
import { Command } from 'commander';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const program = new Command();

program
  .name('ember-sniff')
  .description('ZigBee to PCAP sniffing CLI for EmberZNet-based adapters')
  .version(requireHere('./package.json').version, '--version')
  .requiredOption('-p, --path <path>', 'Serial port path or TCP address of the EmberZNet adapter')
  .requiredOption('-c, --channel <number>', 'ZigBee channel to sniff (11-26)', parseInt)
  .option('-b, --baud-rate <rate>', 'Serial port baud rate', parseInt)
  .option('-r, --rtscts', 'Enable RTS/CTS flow control', false)
  .option('-P, --radio-power <dBm>', 'Radio transmit power [-128 to 127] dBm', parseInt, 5)
  .option('-o, --out <file>', 'out file (default: stdout)')
  .option('-g, --graceful', 'Gracefully handle adapter resets and re-initialize automatically (-g), continuously attempt to re-initialize the adapter (-gg)', (_, prev) => prev + 1, 0)
  .option('-v, --verbose', 'Enable basic logging (-v), more logging (-vv), or debug logging (-vvv)', (_, prev) => prev + 1, 0)
  .parse();

const options = program.opts();

// when output to stdout (no -o flag), disable logging by default unless -v is specified
function writeLog(messageOrLambda, namespace) {
  const message =
    typeof messageOrLambda === 'function'
      ? messageOrLambda()
      : messageOrLambda;

  // all logging shall go to stderr, so that stdout (PCAP) is not polluted with log messages
  process.stderr.write(
    `[${new Date().toISOString()}] ${namespace}: ${message}\n`
  );
}

const logLevel = options.verbose ?? (options.out ? 1 : -1);
const logger = {
  debug:   logLevel >= 3 ? writeLog : () => {},
  info:    logLevel >= 2 ? writeLog : () => {},
  warning: logLevel >= 1 ? writeLog : () => {},
  error:   logLevel >= 0 ? writeLog : () => {}
};
setLogger(logger);

const { path, baudRate, rtscts } = options;
const portConf = { path, baudRate, rtscts, xon: !rtscts, xoff: !rtscts };
logger.debug(`Using port conf: ${JSON.stringify(portConf)}`, 'ember-sniff');

logger.debug(`Opening PCAP output stream to ${options.out ?? 'stdout'}`, 'ember-sniff');
const pcapWriteStream = options.out ? createWriteStream(options.out, 'utf8') : process.stdout;
pcapWriteStream.write(createPcapHeader(PCAP_MAGIC_NUMBER_MS));

(async function init() {
  const trans = new AdapterTransport(portConf);
  
  let ezsp;
  try {
    ezsp = await emberStart(trans);

    const radioTxPower = options.radioPower;
    let status = await ezsp.ezspSetRadioPower(radioTxPower); // radio transmit power [-128-127] dBm
    if (status !== SLStatus.OK) {
      throw new Error(`Failed to set transmit power to ${radioTxPower} status=${SLStatus[status]}.`);
    }

    status = await ezsp.mfglibInternalStart(true);
    if (status !== SLStatus.OK) {
      throw new Error(`Failed to start listening for packets with status=${SLStatus[status]}.`);
    }

    status = await ezsp.mfglibInternalSetChannel(options.channel);
    if (status !== SLStatus.OK) {
      throw new Error(`Failed to set channel with status=${SLStatus[status]}.`);
    }

    if (!trans.isOpen) {
      throw new Error('Adapter connection closed during initialization.');
    }
  } catch (err) {
    // emberStart can fail after opening the transport.
    await (ezsp ? emberStop(ezsp) : trans.close()).catch(stopErr => {
      logger.warning(`Failed to stop adapter: ${stopErr instanceof Error ? stopErr.message : String(stopErr)}`, 'ember-sniff');
    });
    throw err;
  }

  ezsp.ezspMfglibRxHandler = (linkQuality, rssi, data) => {
    logger.debug(`Received packet: ${data.toString('hex')} (linkQuality=${linkQuality}, rssi=${rssi})`, 'ember-sniff');
    data.set(computeCRC16CITTKermit(data.subarray(0, -2)), data.length - 2); // fix static CRC used in EZSP >= v8
    pcapWriteStream.write(createPcapPacketRecordMs(data));
  };

  const onReset = async resetStatus => {
    ezsp.off('ncpNeedsResetAndInit', onReset);
    trans.off('close', onClose);
    logger.error(`Adapter needs reset: status=${EzspStatus[resetStatus]}`, 'ember-sniff');
    if (options.graceful < 1) {
      exit(1);
    }

    try { // should not be required, but just in case the adapter is still listening for packets
      if (trans.isOpen) {
        const endStatus = await ezsp.mfglibInternalEnd();
        if (endStatus !== SLStatus.OK) {
          logger.warning(`Failed to end listening for packets with status=${SLStatus[endStatus]}. Continuing with re-initialization...`, 'ember-sniff');
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      msg === 'NOT_CONNECTED' || logger.warning(`Failed to end listening for packets: ${msg}. Continuing with re-initialization...`, 'ember-sniff');
    }

    try { // immediately stop, this deregisters all listeners
      await emberStop(ezsp);
    } catch (err) {
      logger.warning(`Failed to stop adapter: ${err instanceof Error ? err.message : String(err)}. Continuing with re-initialization...`, 'ember-sniff');
    }

    for (let backoff = 5;; backoff = Math.min(backoff * 2, 120)) { // exponential backoff for re-initialization attempts, max. 2 minutes
      logger.info(`Attempt to gracefully re-initialize adapter in ${backoff} seconds...`, 'ember-sniff');
      await sleep(backoff * 1000);

      try {
        ezsp = await init(); // re-initialize the adapter gracefully
        logger.info('Re-initialization successful', 'ember-sniff');
        break;
      } catch (err) {
        logger.error(`Failed to re-initialize adapter: ${err instanceof Error ? err.message : String(err)}`, 'ember-sniff');
        if (options.graceful < 2) {
          exit(1);
        }
      }
    }
  };

  const onClose = () => onReset(EzspStatus.ERROR_SERIAL_INIT);
  ezsp.once('ncpNeedsResetAndInit', onReset);
  trans.once('close', onClose);

  return ezsp;
})();

