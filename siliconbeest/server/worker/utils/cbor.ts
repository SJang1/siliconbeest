/**
 * Minimal CBOR decoder sufficient for WebAuthn attestation objects.
 * Supports major types 0-5 (uint, negint, bytes, text, array, map) and 7 (simple/bool).
 * No external dependencies.
 */

/* oxlint-disable fp/no-let, fp/no-loop-statements, fp/no-throw-statements, fp/no-try-statements, no-param-reassign, no-explicit-any */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decode a single CBOR data item from the front of `data`.
 * Returns the decoded JavaScript value.
 */
export function decodeCBOR(data: Uint8Array): any {
	const result = decodeItem(data, 0);
	return result.value;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type DecodeResult = {
	value: any;
	offset: number; // byte position *after* this item
}

function decodeItem(data: Uint8Array, offset: number): DecodeResult {
	if (offset >= data.length) {
		throw new Error('CBOR: unexpected end of data');
	}

	const initialByte = data[offset];
	const majorType = initialByte >> 5;
	const additionalInfo = initialByte & 0x1f;

	offset += 1;

	// Read the argument value (length / count / actual value)
	let argResult: { value: number | bigint; offset: number };

	if (additionalInfo < 24) {
		argResult = { value: additionalInfo, offset };
	} else if (additionalInfo === 24) {
		argResult = { value: data[offset], offset: offset + 1 };
	} else if (additionalInfo === 25) {
		argResult = { value: readUint16(data, offset), offset: offset + 2 };
	} else if (additionalInfo === 26) {
		argResult = { value: readUint32(data, offset), offset: offset + 4 };
	} else if (additionalInfo === 27) {
		argResult = { value: readUint64(data, offset), offset: offset + 8 };
	} else if (additionalInfo === 31) {
		// Indefinite length — handled per type below
		argResult = { value: -1, offset };
	} else {
		throw new Error(`CBOR: unsupported additional info ${additionalInfo}`);
	}

	const arg = Number(argResult.value);
	offset = argResult.offset;

	switch (majorType) {
		case 0: // Unsigned integer
			return { value: arg, offset };

		case 1: // Negative integer
			return { value: -1 - arg, offset };

		case 2: // Byte string
			if (arg < 0) {
				// Indefinite-length byte string
				const chunks: Uint8Array[] = [];
				while (data[offset] !== 0xff) {
					const chunk = decodeItem(data, offset);
					if (!(chunk.value instanceof Uint8Array)) {
						throw new Error('CBOR: indefinite byte string chunk is not bytes');
					}
					chunks.push(chunk.value);
					offset = chunk.offset;
				}
				offset += 1; // skip break byte
				return { value: concatBytes(chunks), offset };
			}
			return { value: data.slice(offset, offset + arg), offset: offset + arg };

		case 3: // Text string
			if (arg < 0) {
				// Indefinite-length text string
				let text = '';
				while (data[offset] !== 0xff) {
					const chunk = decodeItem(data, offset);
					if (typeof chunk.value !== 'string') {
						throw new Error('CBOR: indefinite text string chunk is not text');
					}
					text += chunk.value;
					offset = chunk.offset;
				}
				offset += 1;
				return { value: text, offset };
			}
			return {
				value: new TextDecoder().decode(data.slice(offset, offset + arg)),
				offset: offset + arg,
			};

		case 4: { // Array
			const arr: any[] = [];
			if (arg < 0) {
				// Indefinite-length array
				while (data[offset] !== 0xff) {
					const item = decodeItem(data, offset);
					arr.push(item.value);
					offset = item.offset;
				}
				offset += 1;
			} else {
				for (let i = 0; i < arg; i++) {
					const item = decodeItem(data, offset);
					arr.push(item.value);
					offset = item.offset;
				}
			}
			return { value: arr, offset };
		}

		case 5: { // Map
			const map = new Map<any, any>();
			if (arg < 0) {
				// Indefinite-length map
				while (data[offset] !== 0xff) {
					const keyResult = decodeItem(data, offset);
					offset = keyResult.offset;
					const valResult = decodeItem(data, offset);
					offset = valResult.offset;
					map.set(keyResult.value, valResult.value);
				}
				offset += 1;
			} else {
				for (let i = 0; i < arg; i++) {
					const keyResult = decodeItem(data, offset);
					offset = keyResult.offset;
					const valResult = decodeItem(data, offset);
					offset = valResult.offset;
					map.set(keyResult.value, valResult.value);
				}
			}
			return { value: map, offset };
		}

		case 6: // Tag — decode the tagged item and return its value (ignore tag number)
			return decodeItem(data, offset);

		case 7: // Simple values / floats
			if (additionalInfo === 20) return { value: false, offset };
			if (additionalInfo === 21) return { value: true, offset };
			if (additionalInfo === 22) return { value: null, offset };
			if (additionalInfo === 23) return { value: undefined, offset };
			if (additionalInfo === 25) {
				// float16 — not commonly used in WebAuthn, skip
				return { value: 0, offset };
			}
			if (additionalInfo === 26) {
				// float32
				const view = new DataView(data.buffer, data.byteOffset + offset - 4, 4);
				return { value: view.getFloat32(0), offset };
			}
			if (additionalInfo === 27) {
				// float64
				const view = new DataView(data.buffer, data.byteOffset + offset - 8, 8);
				return { value: view.getFloat64(0), offset };
			}
			return { value: arg, offset };

		default:
			throw new Error(`CBOR: unsupported major type ${majorType}`);
	}
}

// ---------------------------------------------------------------------------
// Binary read helpers
// ---------------------------------------------------------------------------

function readUint16(data: Uint8Array, offset: number): number {
	return (data[offset] << 8) | data[offset + 1];
}

function readUint32(data: Uint8Array, offset: number): number {
	return (
		((data[offset] << 24) >>> 0) +
		(data[offset + 1] << 16) +
		(data[offset + 2] << 8) +
		data[offset + 3]
	);
}

function readUint64(data: Uint8Array, offset: number): bigint {
	const hi = BigInt(readUint32(data, offset));
	const lo = BigInt(readUint32(data, offset + 4));
	return (hi << 32n) | lo;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	let totalLength = 0;
	for (const chunk of chunks) {
		totalLength += chunk.length;
	}
	const result = new Uint8Array(totalLength);
	let pos = 0;
	for (const chunk of chunks) {
		result.set(chunk, pos);
		pos += chunk.length;
	}
	return result;
}
