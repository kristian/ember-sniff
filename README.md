# Ember Sniff

A packet sniffer for capturing ZigBee traffic from EmberZNet-based adapters. Ember Sniff interfaces EmberZNet-based adapters (over serial or TCP) for capturing IEEE 802.15.4 ZigBee traffic at 2.4 GHz.

The utility reads packets from the EmberZNet adapter, converts them to (P)CAP format and writes to standard output or a file.

## Installation

```bash
npm install -g ember-sniff
```

## Usage

```bash
ember-sniff -p <path> -c <channel> [options]
```

### Options

- `-p, --path <path>` - Serial port path or TCP address (required)
- `-c, --channel <number>` - ZigBee channel to sniff, 11-26 (required)
- `-b, --baud-rate <rate>` - Serial port baud rate
- `-r, --rtscts` - Enable RTS/CTS flow control
- `-P, --radio-power <dBm>` - Radio transmit power, default: 5
- `-o, --out <file>` - Output file (default: stdout)
- `-g, --graceful` - Graceful restarts on adapter failure: `-g` (single attempt), `-gg` (continuously)
- `-v, --verbose` - Logging: `-v` (basic), `-vv` (more), `-vvv` (debug)

### Examples

```bash
# Sniff channel 15 and pipe to Wireshark
ember-sniff -p tcp://192.168.1.42:6638 -c 15 | wireshark -k -i -

# Sniff channel 20 from serial port and save to file
ember-sniff -p /dev/ttyUSB0 -c 20 -o capture.pcap
```

## Author

Ember Sniff for Node.js by [Kristian Kraljić](https://kra.lc/).

## Bugs

Please file any questions / issues [on Github](https://github.com/kristian/ember-sniff/issues).

## License

This library is licensed under the [Apache 2.0](LICENSE) license.
