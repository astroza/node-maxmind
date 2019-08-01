import assert from 'assert';
import bigInt from 'big-integer';
// @ts-ignore
import lru from 'tiny-lru';
import { OpenOpts } from '.';
import utils from './utils';

const types = [
  'extended', //  0
  'pointer', //  1
  'utf8_string', //  2
  'double', //  3
  'bytes', //  4
  'uint16', //  5
  'uint32', //  6
  'map', //  7
  'int32', //  8
  'uint64', //  9
  'uint128', // 10
  'array', // 11
  'container', // 12
  'end_marker', // 13
  'boolean', // 14
  'float', // 15
];

const pointerValueOffset = [0, 2048, 526336, 0];

interface Cursor {
  value: any;
  offset: number;
}

interface Cache {
  get(key: string | number): any;
  set(key: string | number, value: any): any;
}

const cursor = (value: any, offset: number): Cursor => ({ value, offset });

export default class Decoder {
  public telemetry: Record<string, any> = {};
  private db: Buffer;
  private baseOffset: number;
  private cache: Cache;

  constructor(db: Buffer, baseOffset: number = 0, opts?: OpenOpts) {
    assert((this.db = db), 'File stream is required');
    this.baseOffset = baseOffset;

    this.cache = lru(
      opts && opts.cache && opts.cache.max ? opts.cache.max : 6000
    );
  }

  public decode(offset: number): any {
    let tmp: any;
    const ctrlByte = this.db[offset++];
    let type = types[ctrlByte >> 5];

    if (type === 'pointer') {
      tmp = this.decodePointer(ctrlByte, offset);
      return cursor(this.decodeFast(tmp.value).value, tmp.offset);
    }

    if (type === 'extended') {
      tmp = this.db[offset] + 7;
      if (tmp < 8) {
        throw new Error(
          'Invalid Extended Type at offset ' + offset + ' val ' + tmp
        );
      }

      type = types[tmp];
      offset++;
    }

    const size = this.sizeFromCtrlByte(ctrlByte, offset);
    return this.decodeByType(type, size.offset, size.value);
  }

  public decodeFast(offset: number) {
    const cached = this.cache.get(offset);
    if (cached) {
      return cached;
    }

    const result = this.decode(offset);
    this.cache.set(offset, result);
    return result;
  }

  public decodeByType(type: string, offset: number, size: number): Cursor {
    const newOffset = offset + size;

    // ipv4 types occurrence stats:
    // 3618591 x utf8_string
    // 448163 x map
    // 175085 x uint32
    // 83040 x double
    // 24745 x array
    // 3 x uint16
    // 1 x uint64
    // 14 x boolean
    switch (type) {
      case 'utf8_string':
        return cursor(this.decodeString(offset, size), newOffset);
      case 'map':
        return this.decodeMap(size, offset);
      case 'uint32':
        return cursor(this.decodeUint(offset, size), newOffset);
      case 'double':
        return cursor(this.decodeDouble(offset), newOffset);
      case 'array':
        return this.decodeArray(size, offset);
      case 'boolean':
        return cursor(this.decodeBoolean(size), offset);
      case 'float':
        return cursor(this.decodeFloat(offset), newOffset);
      case 'bytes':
        return cursor(this.decodeBytes(offset, size), newOffset);
      case 'uint16':
        return cursor(this.decodeUint(offset, size), newOffset);
      case 'int32':
        return cursor(this.decodeInt32(offset, size), newOffset);
      case 'uint64':
        return cursor(this.decodeUint(offset, size), newOffset);
      case 'uint128':
        return cursor(this.decodeUint(offset, size), newOffset);
    }

    throw new Error('Unknown type ' + type + ' at offset ' + offset);
  }

  public sizeFromCtrlByte(ctrlByte: number, offset: number): Cursor {
    // The first three bits of the control byte tell you what type the field is. If
    // these bits are all 0, then this is an "extended" type, which means that the
    // *next* byte contains the actual type. Otherwise, the first three bits will
    // contain a number from 1 to 7, the actual type for the field.
    // var type = ctrlByte >> 3;

    // The next five bits in the control byte tell you how long the data field's
    // payload is, except for maps and pointers. Maps and pointers use this size
    // information a bit differently.``

    const size = ctrlByte & 0x1f;

    // If the five bits are smaller than 29, then those bits are the payload size in
    // bytes. For example:
    //   01000010          UTF-8 string - 2 bytes long
    //   01011100          UTF-8 string - 28 bytes long
    //   11000001          unsigned 32-bit int - 1 byte long
    //   00000011 00000011 unsigned 128-bit int - 3 bytes long
    if (size < 29) {
      return cursor(size, offset);
    }

    // If the value is 29, then the size is 29 + *the next byte after the type
    // specifying bytes as an unsigned integer*.
    if (size === 29) {
      return cursor(29 + this.db[offset], offset + 1);
    }

    // If the value is 30, then the size is 285 + *the next two bytes after the type
    // specifying bytes as a single unsigned integer*.
    if (size === 30) {
      return cursor(285 + this.db.readUInt16BE(offset, false), offset + 2);
    }

    // At this point `size` is always 31.
    // If the value is 31, then the size is 65,821 + *the next three bytes after the
    // type specifying bytes as a single unsigned integer*.
    return cursor(
      65821 +
        utils.concat3(
          this.db[offset],
          this.db[offset + 1],
          this.db[offset + 2]
        ),
      offset + 3
    );
  }

  public decodeBytes(offset: number, size: number): Buffer {
    return this.db.slice(offset, offset + size);
  }

  public decodePointer(ctrlByte: number, offset: number): Cursor {
    // Pointers use the last five bits in the control byte to calculate the pointer value.

    // To calculate the pointer value, we start by subdiving the five bits into two
    // groups. The first two bits indicate the size, and the next three bits are part
    // of the value, so we end up with a control byte breaking down like this:
    // 001SSVVV.
    const pointerSize = (ctrlByte >> 3) & 3;

    const pointer = this.baseOffset + pointerValueOffset[pointerSize];
    let packed = 0;

    // The size can be 0, 1, 2, or 3.

    // If the size is 0, the pointer is built by appending the next byte to the last
    // three bits to produce an 11-bit value.
    if (pointerSize === 0) {
      packed = utils.concat2(ctrlByte & 7, this.db[offset]);

      // If the size is 1, the pointer is built by appending the next two bytes to the
      // last three bits to produce a 19-bit value + 2048.
    } else if (pointerSize === 1) {
      packed = utils.concat3(
        ctrlByte & 7,
        this.db[offset],
        this.db[offset + 1]
      );

      // If the size is 2, the pointer is built by appending the next three bytes to the
      // last three bits to produce a 27-bit value + 526336.
    } else if (pointerSize === 2) {
      packed = utils.concat4(
        ctrlByte & 7,
        this.db[offset],
        this.db[offset + 1],
        this.db[offset + 2]
      );

      // At next point `size` is always 3.
      // Finally, if the size is 3, the pointer's value is contained in the next four
      // bytes as a 32-bit value. In this case, the last three bits of the control byte
      // are ignored.
    } else {
      packed = this.db.readUInt32BE(offset, true);
    }

    offset += pointerSize + 1;
    return cursor(pointer + packed, offset);
  }

  public decodeArray(size: number, offset: number): Cursor {
    let tmp;
    const array = [];

    for (let i = 0; i < size; i++) {
      tmp = this.decode(offset);
      offset = tmp.offset;
      array.push(tmp.value);
    }

    return cursor(array, offset);
  }

  public decodeBoolean(size: number) {
    return size !== 0;
  }

  public decodeDouble(offset: number) {
    return this.db.readDoubleBE(offset, true);
  }

  public decodeFloat(offset: number) {
    return this.db.readFloatBE(offset, true);
  }

  public decodeMap(size: number, offset: number) {
    let tmp;
    let key;

    const map: Record<string, any> = {};

    for (let i = 0; i < size; i++) {
      tmp = this.decode(offset);
      key = tmp.value;
      tmp = this.decode(tmp.offset);
      offset = tmp.offset;
      map[key] = tmp.value;
    }

    return cursor(map, offset);
  }

  public decodeInt32(offset: number, size: number) {
    if (size === 0) {
      return 0;
    }
    return this.db.readInt32BE(offset, true);
  }

  public decodeUint(offset: number, size: number) {
    switch (size) {
      case 0:
        return 0;
      case 1:
        return this.db[offset];
      case 2:
        return utils.concat2(this.db[offset + 0], this.db[offset + 1]);
      case 3:
        return utils.concat3(
          this.db[offset + 0],
          this.db[offset + 1],
          this.db[offset + 2]
        );
      case 4:
        return utils.concat4(
          this.db[offset + 0],
          this.db[offset + 1],
          this.db[offset + 2],
          this.db[offset + 3]
        );
      case 8:
        return this.decodeBigUint(offset, size);
      case 16:
        return this.decodeBigUint(offset, size);
    }
    return 0;
  }

  public decodeString(offset: number, size: number) {
    // @ts-ignore
    return this.db.utf8Slice(offset, offset + size);

    // A little slower:
    // return this.db.toString('utf8', offset, offset + size);
  }

  public decodeBigUint(offset: number, size: number) {
    const buffer = new Buffer(size);
    this.db.copy(buffer, 0, offset, offset + size);

    let integer = bigInt(0);
    const numberOfLongs = size / 4;
    for (let i = 0; i < numberOfLongs; i++) {
      integer = bigInt(integer).multiply(4294967296).add(buffer.readUInt32BE(i << 2, true));
    }

    return integer.toString();
  }
}
