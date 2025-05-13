// https://deno.land/std@0.185.0/bytes/bytes_list.ts
var BytesList = class {
  #len = 0;
  #chunks = [];
  constructor() {
  }
  /**
   * Total size of bytes
   */
  size() {
    return this.#len;
  }
  /**
   * Push bytes with given offset infos
   */
  add(value, start = 0, end = value.byteLength) {
    if (value.byteLength === 0 || end - start === 0) {
      return;
    }
    checkRange(start, end, value.byteLength);
    this.#chunks.push({
      value,
      end,
      start,
      offset: this.#len
    });
    this.#len += end - start;
  }
  /**
   * Drop head `n` bytes.
   */
  shift(n) {
    if (n === 0) {
      return;
    }
    if (this.#len <= n) {
      this.#chunks = [];
      this.#len = 0;
      return;
    }
    const idx = this.getChunkIndex(n);
    this.#chunks.splice(0, idx);
    const [chunk] = this.#chunks;
    if (chunk) {
      const diff = n - chunk.offset;
      chunk.start += diff;
    }
    let offset = 0;
    for (const chunk2 of this.#chunks) {
      chunk2.offset = offset;
      offset += chunk2.end - chunk2.start;
    }
    this.#len = offset;
  }
  /**
   * Find chunk index in which `pos` locates by binary-search
   * returns -1 if out of range
   */
  getChunkIndex(pos) {
    let max = this.#chunks.length;
    let min = 0;
    while (true) {
      const i = min + Math.floor((max - min) / 2);
      if (i < 0 || this.#chunks.length <= i) {
        return -1;
      }
      const { offset, start, end } = this.#chunks[i];
      const len = end - start;
      if (offset <= pos && pos < offset + len) {
        return i;
      } else if (offset + len <= pos) {
        min = i + 1;
      } else {
        max = i - 1;
      }
    }
  }
  /**
   * Get indexed byte from chunks
   */
  get(i) {
    if (i < 0 || this.#len <= i) {
      throw new Error("out of range");
    }
    const idx = this.getChunkIndex(i);
    const { value, offset, start } = this.#chunks[idx];
    return value[start + i - offset];
  }
  /**
   * Iterator of bytes from given position
   */
  *iterator(start = 0) {
    const startIdx = this.getChunkIndex(start);
    if (startIdx < 0) return;
    const first = this.#chunks[startIdx];
    let firstOffset = start - first.offset;
    for (let i = startIdx; i < this.#chunks.length; i++) {
      const chunk = this.#chunks[i];
      for (let j = chunk.start + firstOffset; j < chunk.end; j++) {
        yield chunk.value[j];
      }
      firstOffset = 0;
    }
  }
  /**
   * Returns subset of bytes copied
   */
  slice(start, end = this.#len) {
    if (end === start) {
      return new Uint8Array();
    }
    checkRange(start, end, this.#len);
    const result = new Uint8Array(end - start);
    const startIdx = this.getChunkIndex(start);
    const endIdx = this.getChunkIndex(end - 1);
    let written = 0;
    for (let i = startIdx; i <= endIdx; i++) {
      const {
        value: chunkValue,
        start: chunkStart,
        end: chunkEnd,
        offset: chunkOffset
      } = this.#chunks[i];
      const readStart = chunkStart + (i === startIdx ? start - chunkOffset : 0);
      const readEnd = i === endIdx ? end - chunkOffset + chunkStart : chunkEnd;
      const len = readEnd - readStart;
      result.set(chunkValue.subarray(readStart, readEnd), written);
      written += len;
    }
    return result;
  }
  /**
   * Concatenate chunks into single Uint8Array copied.
   */
  concat() {
    const result = new Uint8Array(this.#len);
    let sum = 0;
    for (const { value, start, end } of this.#chunks) {
      result.set(value.subarray(start, end), sum);
      sum += end - start;
    }
    return result;
  }
};
function checkRange(start, end, len) {
  if (start < 0 || len < start || end < 0 || len < end || end < start) {
    throw new Error("invalid range");
  }
}

// https://deno.land/std@0.185.0/bytes/concat.ts
function concat(...buf) {
  let length = 0;
  for (const b of buf) {
    length += b.length;
  }
  const output = new Uint8Array(length);
  let index = 0;
  for (const b of buf) {
    output.set(b, index);
    index += b.length;
  }
  return output;
}

// https://deno.land/std@0.185.0/bytes/copy.ts
function copy(src, dst, off = 0) {
  off = Math.max(0, Math.min(off, dst.byteLength));
  const dstBytesAvailable = dst.byteLength - off;
  if (src.byteLength > dstBytesAvailable) {
    src = src.subarray(0, dstBytesAvailable);
  }
  dst.set(src, off);
  return src.byteLength;
}

// https://deno.land/std@0.185.0/bytes/ends_with.ts
function endsWith(source, suffix) {
  for (let srci = source.length - 1, sfxi = suffix.length - 1; sfxi >= 0; srci--, sfxi--) {
    if (source[srci] !== suffix[sfxi]) return false;
  }
  return true;
}

// https://deno.land/std@0.185.0/bytes/equals.ts
function equalsNaive(a, b) {
  for (let i = 0; i < b.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
function equals32Bit(a, b) {
  const len = a.length;
  const compressable = Math.floor(len / 4);
  const compressedA = new Uint32Array(a.buffer, 0, compressable);
  const compressedB = new Uint32Array(b.buffer, 0, compressable);
  for (let i = compressable * 4; i < len; i++) {
    if (a[i] !== b[i]) return false;
  }
  for (let i = 0; i < compressedA.length; i++) {
    if (compressedA[i] !== compressedB[i]) return false;
  }
  return true;
}
function equals(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  return a.length < 1e3 ? equalsNaive(a, b) : equals32Bit(a, b);
}

// https://deno.land/std@0.185.0/bytes/index_of_needle.ts
function indexOfNeedle(source, needle, start = 0) {
  if (start >= source.length) {
    return -1;
  }
  if (start < 0) {
    start = Math.max(0, source.length + start);
  }
  const s = needle[0];
  for (let i = start; i < source.length; i++) {
    if (source[i] !== s) continue;
    const pin = i;
    let matched = 1;
    let j = i;
    while (matched < needle.length) {
      j++;
      if (source[j] !== needle[j - pin]) {
        break;
      }
      matched++;
    }
    if (matched === needle.length) {
      return pin;
    }
  }
  return -1;
}

// https://deno.land/std@0.185.0/bytes/includes_needle.ts
function includesNeedle(source, needle, start = 0) {
  return indexOfNeedle(source, needle, start) !== -1;
}

// https://deno.land/std@0.185.0/bytes/last_index_of_needle.ts
function lastIndexOfNeedle(source, needle, start = source.length - 1) {
  if (start < 0) {
    return -1;
  }
  if (start >= source.length) {
    start = source.length - 1;
  }
  const e = needle[needle.length - 1];
  for (let i = start; i >= 0; i--) {
    if (source[i] !== e) continue;
    const pin = i;
    let matched = 1;
    let j = i;
    while (matched < needle.length) {
      j--;
      if (source[j] !== needle[needle.length - 1 - (pin - j)]) {
        break;
      }
      matched++;
    }
    if (matched === needle.length) {
      return pin - needle.length + 1;
    }
  }
  return -1;
}

// https://deno.land/std@0.185.0/bytes/repeat.ts
function repeat(source, count) {
  if (count === 0) {
    return new Uint8Array();
  }
  if (count < 0) {
    throw new RangeError("bytes: negative repeat count");
  }
  if (!Number.isInteger(count)) {
    throw new Error("bytes: repeat count must be an integer");
  }
  const nb = new Uint8Array(source.length * count);
  let bp = copy(source, nb);
  for (; bp < nb.length; bp *= 2) {
    copy(nb.slice(0, bp), nb, bp);
  }
  return nb;
}

// https://deno.land/std@0.185.0/bytes/starts_with.ts
function startsWith(source, prefix) {
  for (let i = 0, max = prefix.length; i < max; i++) {
    if (source[i] !== prefix[i]) return false;
  }
  return true;
}
export {
  BytesList,
  concat,
  copy,
  endsWith,
  equals,
  includesNeedle,
  indexOfNeedle,
  lastIndexOfNeedle,
  repeat,
  startsWith
};
