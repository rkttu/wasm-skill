/** A deliberately small, bounded reader for the scalar-v1 Wasm ABI. */
export const C_TYPES = Object.freeze({
  int32_t: 'i32', uint32_t: 'i32', int64_t: 'i64', uint64_t: 'i64',
  float: 'f32', double: 'f64',
});

const VALUE_TYPES = new Map([[0x7f, 'i32'], [0x7e, 'i64'], [0x7d, 'f32'], [0x7c, 'f64']]);
const MAX_MODULE_BYTES = 16 * 1024 * 1024;
const MAX_VECTOR_ITEMS = 100_000;

class Reader {
  constructor(bytes, start = 0, end = bytes.length) {
    this.bytes = bytes;
    this.pos = start;
    this.end = end;
  }

  byte() {
    if (this.pos >= this.end) throw new Error('Truncated Wasm binary.');
    return this.bytes[this.pos++];
  }

  u32() {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = this.byte();
      if (i === 4 && (byte & 0xf0) !== 0) throw new Error('Wasm u32 LEB128 overflow.');
      value += (byte & 0x7f) * (2 ** (7 * i));
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error('Wasm u32 LEB128 exceeds five bytes.');
  }

  count() {
    const count = this.u32();
    if (count > MAX_VECTOR_ITEMS || count > this.end - this.pos) {
      throw new Error('Wasm vector exceeds the reader limit or its section bounds.');
    }
    return count;
  }

  name() {
    const length = this.u32();
    if (length > this.end - this.pos) throw new Error('Wasm name exceeds section bounds.');
    const name = new TextDecoder('utf-8', {fatal: true}).decode(this.bytes.subarray(this.pos, this.pos + length));
    this.pos += length;
    return name;
  }

  values() {
    const values = [];
    const count = this.count();
    for (let i = 0; i < count; i++) {
      const code = this.byte();
      const value = VALUE_TYPES.get(code);
      if (!value) throw new Error(`Unsupported Wasm value type 0x${code.toString(16)}; scalar-v1 permits i32, i64, f32 and f64.`);
      values.push(value);
    }
    return values;
  }

  done() {
    if (this.pos !== this.end) throw new Error('Unexpected trailing data in a parsed Wasm section.');
  }
}

/**
 * Validate the entire binary with the engine, then extract the actual public ABI.
 * This is an ABI reader, not an instruction parser or a proof of source semantics.
 */
export function inspectWasm(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 8 || bytes.length > MAX_MODULE_BYTES) throw new Error('Wasm binary must be between 8 bytes and 16 MiB.');
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  if (header.some((byte, i) => bytes[i] !== byte)) throw new Error('Expected a Wasm version 1 module header.');
  if (!WebAssembly.validate(bytes)) throw new Error('The WebAssembly engine rejected the binary as invalid.');

  const reader = new Reader(bytes, 8);
  const types = [];
  const functions = [];
  const rawExports = [];
  const memories = [];
  const seen = new Set();
  let codeCount = 0;

  while (reader.pos < reader.end) {
    const id = reader.byte();
    const length = reader.u32();
    if (length > reader.end - reader.pos) throw new Error('Wasm section exceeds the module bounds.');
    const section = new Reader(bytes, reader.pos, reader.pos + length);
    reader.pos += length;
    if (id !== 0) {
      if (seen.has(id)) throw new Error(`Duplicate Wasm section ${id}.`);
      seen.add(id);
    }

    if (id === 0) {
      // Engine validation already checks custom-section framing. Payload is opaque.
      continue;
    }
    if (id === 1) {
      const count = section.count();
      for (let i = 0; i < count; i++) {
        if (section.byte() !== 0x60) throw new Error('Unsupported Wasm type form; scalar-v1 expects ordinary function types.');
        types.push({params: section.values(), results: section.values()});
      }
      section.done();
    } else if (id === 2) {
      if (section.u32() !== 0) throw new Error('External imports are forbidden by the scalar-v1 ABI.');
      section.done();
    } else if (id === 3) {
      const count = section.count();
      for (let i = 0; i < count; i++) functions.push(section.u32());
      section.done();
    } else if (id === 5) {
      const count = section.count();
      if (count > 1) throw new Error('scalar-v1 permits at most one linear memory.');
      for (let i = 0; i < count; i++) {
        const flags = section.u32();
        if (flags !== 1) throw new Error('Memory must be wasm32, unshared, and have an explicit maximum.');
        const minimum = section.u32();
        const maximum = section.u32();
        if (minimum > maximum || maximum > 256) throw new Error('Linear memory exceeds the 16 MiB maximum.');
        memories.push({index: i, minimum_pages: minimum, maximum_pages: maximum});
      }
      section.done();
    } else if (id === 7) {
      const count = section.count();
      for (let i = 0; i < count; i++) rawExports.push({name: section.name(), kind: section.byte(), index: section.u32()});
      section.done();
    } else if (id === 8) {
      throw new Error('Start functions are forbidden by the scalar-v1 ABI.');
    } else if (id === 10) {
      codeCount = section.u32();
      // The engine validates function bodies and every remaining section.
    }
    // Section order is validated by the engine, not numeric section ids:
    // notably data-count (12) can precede code (10).
  }

  if (functions.length !== codeCount) throw new Error('Function and code section counts differ.');
  const exports = rawExports.map((entry) => {
    if (entry.kind === 0) {
      const typeIndex = functions[entry.index];
      const type = types[typeIndex];
      if (!type) throw new Error(`Invalid function/type index for export ${entry.name}.`);
      if (type.results.length > 1) throw new Error(`Export ${entry.name} has multiple results; scalar-v1 permits zero or one.`);
      return {name: entry.name, kind: 'function', index: entry.index, params: type.params, results: type.results};
    }
    if (entry.kind === 2) {
      const memory = memories[entry.index];
      if (!memory) throw new Error(`Invalid memory index for export ${entry.name}.`);
      if (entry.name !== 'memory') throw new Error('The only allowed memory export name is memory.');
      if (memory.export) throw new Error('A linear memory may only be exported once.');
      memory.export = entry.name;
      return {name: entry.name, kind: 'memory', index: entry.index};
    }
    throw new Error(`Export ${entry.name} has an unsupported kind; only functions and memory are public.`);
  });

  return {exports, imports: [], memories};
}
