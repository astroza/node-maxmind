import net from 'net';

const re = /\d+/g;

const parseIPv4 = (input: string): number[] => {
  const match = input.match(re);
  return [+match![0], +match![1], +match![2], +match![3]];
};

const hex = (v: string): string => {
  v = parseInt(v, 10).toString(16);
  return v.length === 2 ? v : '0' + v;
};

const parseIPv6 = (ip: string): number[] => {
  const addr = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  let i;
  let parsed;
  let chunk;

  // ipv4 e.g. `::ffff:64.17.254.216`
  if (ip.indexOf('.') > -1) {
    ip = ip.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)/, (match, a, b, c, d) => {
      return hex(a) + hex(b) + ':' + hex(c) + hex(d);
    });
  }

  const [left, right] = ip.split('::', 2);

  if (left) {
    parsed = left.split(':');
    for (i = 0; i < parsed.length; i++) {
      chunk = parseInt(parsed[i], 16);
      addr[i * 2] = chunk >> 8;
      addr[i * 2 + 1] = chunk & 0xff;
    }
  }

  if (right) {
    parsed = right.split(':');
    const offset = 16 - parsed.length * 2; // 2 bytes per chunk
    for (i = 0; i < parsed.length; i++) {
      chunk = parseInt(parsed[i], 16);
      addr[offset + i * 2] = chunk >> 8;
      addr[offset + (i * 2 + 1)] = chunk & 0xff;
    }
  }

  return addr;
};

const parse = (ip: string): number[] => {
  return ip.indexOf(':') === -1 ? parseIPv4(ip) : parseIPv6(ip);
};


const bitAt = (rawAddress: Buffer | number[], idx: number): number => {
  // 8 bits per octet in the buffer (>>3 is slightly faster than Math.floor(idx/8))
  const octetIdx = idx >> 3;

  // Offset within the octet (basicallg equivalent to 8  - (idx % 8))
  const bitIdx = 7 ^ (idx & 7);

  // Shift the offset rightwards by bitIdx bits and & it to grab the bit
  return (rawAddress[octetIdx] >> bitIdx) & 1;
};

const validate = (ip: string): boolean => {
  const version = net.isIP(ip);
  return version === 4 || version === 6;
};

export default {
  bitAt,
  parse,
  validate,
};
