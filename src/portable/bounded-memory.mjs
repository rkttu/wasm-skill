/** Add or tighten an unshared wasm32 memory maximum without changing code. */
export function boundMemory(input, maximumPages) {
  if (!Number.isInteger(maximumPages) || maximumPages < 1 || maximumPages > 65536) throw new Error('Invalid Wasm memory page limit.');
  const bytes = Buffer.from(input);
  if (!WebAssembly.validate(bytes)) throw new Error('Cannot bound an invalid Wasm module.');
  const encode = (value) => {
    const result = [];
    do { const part = value & 127; value = Math.floor(value / 128); result.push(part | (value ? 128 : 0)); } while (value);
    return Buffer.from(result);
  };
  let position = 8;
  let end = bytes.length;
  const read = () => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      if (position >= end) throw new Error('Truncated Wasm memory or section length.');
      const byte = bytes[position++];
      if (i === 4 && (byte & 240)) throw new Error('Wasm integer overflow.');
      value += (byte & 127) * 2 ** (i * 7);
      if (!(byte & 128)) return value;
    }
    throw new Error('Invalid Wasm integer encoding.');
  };
  const parts = [bytes.subarray(0, 8)];
  let seenMemory = false;
  while (position < bytes.length) {
    const sectionStart = position;
    const id = bytes[position++];
    end = bytes.length;
    const size = read();
    const sectionEnd = position + size;
    if (sectionEnd > bytes.length) throw new Error('Wasm section exceeds module size.');
    if (id === 5) {
      if (seenMemory) throw new Error('Duplicate Wasm memory section.');
      seenMemory = true;
      end = sectionEnd;
      const count = read();
      if (count !== 1) throw new Error('Expected exactly one Wasm memory.');
      const flags = read();
      if (flags !== 0 && flags !== 1) throw new Error('Only unshared wasm32 memory can be bounded.');
      const minimum = read();
      const originalMaximum = flags === 1 ? read() : maximumPages;
      const maximum = Math.min(originalMaximum, maximumPages);
      if (minimum > maximum) throw new Error(`Wasm initial memory exceeds the ${maximumPages * 65536} byte limit.`);
      if (position !== sectionEnd) throw new Error('Unexpected Wasm memory section data.');
      const payload = Buffer.concat([encode(1), encode(1), encode(minimum), encode(maximum)]);
      parts.push(Buffer.from([5]), encode(payload.length), payload);
    } else parts.push(bytes.subarray(sectionStart, sectionEnd));
    position = sectionEnd;
  }
  const result = Buffer.concat(parts);
  if (!WebAssembly.validate(result)) throw new Error('WebAssembly rejected the bounded module.');
  return result;
}
