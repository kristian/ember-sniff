#!/usr/bin/env node
import './silence-ember-zli.js';
import { createWriteStream } from 'node:fs';

import { setLogger } from 'zigbee-herdsman';
import { SLStatus } from 'zigbee-herdsman/dist/adapter/ember/enums.js';
import { createPcapFileHeader as createPcapHeader, createPcapPacketRecordMs, PCAP_MAGIC_NUMBER_MS } from 'ember-zli/dist/utils/wireshark.js';

import { emberStart } from 'ember-zli/dist/utils/ember.js';
import { computeCRC16CITTKermit } from 'ember-zli/dist/utils/utils.js';
import { Command } from 'commander';

const program = new Command();

program
  .name('ember-sniff')
  .description('ZigBee to PCAP sniffing CLI for EmberZNet-based adapters')
  .requiredOption('-p, --path <path>', 'Serial port path or TCP address of the EmberZNet adapter')
  .requiredOption('-c, --channel <number>', 'ZigBee channel to sniff (11-26)', parseInt)
  .option('-b, --baud-rate <rate>', 'Serial port baud rate', parseInt)
  .option('-r, --rtscts', 'Enable RTS/CTS flow control', false)
  .option('-P, --radio-power <dBm>', 'Radio transmit power [-128 to 127] dBm', parseInt, 5)
  .option('-o, --out <file>', 'out file (default: stdout)')
  .option('-v, --verbose', 'Enable basic logging (-v), more logging (-vv), or debug logging (-vvv)', (_, prev) => prev + 1, 0)
  .parse();

const options = program.opts();

// when output to stdout (no -o flag), disable logging by default unless -v is specified
const logLevel = options.verbose ?? (options.out ? 1 : -1);
const logger = {
  debug:  logLevel >= 3 ? console.log : () => {},
  info:   logLevel >= 2 ? console.log : () => {},
  warning:logLevel >= 1 ? console.warn : () => {},
  error:  logLevel >= 0 ? console.error : () => {}
};
setLogger(logger);

const { path, baudRate, rtscts } = options;
const portConf = { path, baudRate, rtscts, xon: !rtscts, xoff: !rtscts };
logger.debug(`Using port conf: ${JSON.stringify(portConf)}`);
const ezsp = await emberStart(portConf);

const pcapWriteStream = options.out ? createWriteStream(options.out, 'utf8') : process.stdout;
pcapWriteStream.write(createPcapHeader(PCAP_MAGIC_NUMBER_MS));

let status = await ezsp.ezspSetRadioPower(options.radioPower); // radio transmit power [-128-127] dBm
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

ezsp.ezspMfglibRxHandler = (linkQuality, rssi, data) => {
  data.set(computeCRC16CITTKermit(data.subarray(0, -2)), data.length - 2); // fix static CRC used in EZSP >= v8
  pcapWriteStream.write(createPcapPacketRecordMs(data));
};
