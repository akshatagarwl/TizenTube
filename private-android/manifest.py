"""Add a compiled provider and cleartext-loader flag without rewriting existing AXML attributes."""
import struct

NO_STRING = 0xFFFFFFFF
STRING_POOL = 1
RESOURCE_MAP = 0x180
START_ELEMENT = 0x102
END_ELEMENT = 0x103


def chunks(binary):
    offset = 8
    while offset < len(binary):
        kind, header_size, size = struct.unpack_from('<HHI', binary, offset)
        if size < header_size or offset + size > len(binary):
            raise ValueError('Malformed AXML chunk')
        yield kind, binary[offset:offset + size]
        offset += size


def read_length(data, position, width):
    format_code = '<H' if width == 2 else '<B'
    value = struct.unpack_from(format_code, data, position)[0]
    position += width
    high_bit = 0x8000 if width == 2 else 0x80
    if value & high_bit:
        following = struct.unpack_from(format_code, data, position)[0]
        position += width
        value = ((value & (high_bit - 1)) << (width * 8)) | following
    return value, position


def strings(pool):
    count, styles, flags, start = struct.unpack_from('<IIII', pool, 8)
    if styles:
        raise ValueError('Styled manifest string pools are unsupported')
    result = []
    for index in range(count):
        position = start + struct.unpack_from('<I', pool, 28 + index * 4)[0]
        if flags & 0x100:
            _, position = read_length(pool, position, 1)
            length, position = read_length(pool, position, 1)
            result.append(pool[position:position + length].decode('utf-8'))
        else:
            length, position = read_length(pool, position, 2)
            result.append(pool[position:position + length * 2].decode('utf-16le'))
    return result


def string_pool(values):
    offsets = []
    data = bytearray()
    for value in values:
        encoded = value.encode('utf-16le')
        length = len(encoded) // 2
        if length >= 0x8000:
            raise ValueError('Unexpected oversized manifest string')
        offsets.append(len(data))
        data.extend(struct.pack('<H', length) + encoded + b'\0\0')
    data.extend(b'\0' * (-len(data) % 4))
    start = 28 + 4 * len(values)
    return (struct.pack('<HHIIIIII', STRING_POOL, 28, start + len(data),
                        len(values), 0, 0, start, 0)
            + struct.pack('<' + 'I' * len(offsets), *offsets) + data)


def remap_attribute(attribute, mapping):
    namespace, name, raw, size, unused, value_type, value = struct.unpack('<IIIHBBI', attribute)
    namespace = mapping[namespace] if namespace != NO_STRING else NO_STRING
    raw = mapping[raw] if raw != NO_STRING else NO_STRING
    if value_type == 3:
        value = mapping[value]
    return struct.pack('<IIIHBBI', namespace, mapping[name], raw, size, unused, value_type, value)


def remap_element(chunk, mapping):
    result = bytearray(chunk)
    namespace, name = struct.unpack_from('<II', result, 16)
    struct.pack_into('<II', result, 16,
                     mapping[namespace] if namespace != NO_STRING else NO_STRING, mapping[name])
    if struct.unpack_from('<H', chunk)[0] == START_ELEMENT:
        attribute_start, attribute_size, count = struct.unpack_from('<HHH', chunk, 24)
        if attribute_size != 20:
            raise ValueError('Unexpected attribute size')
        for index in range(count):
            offset = 16 + attribute_start + index * attribute_size
            result[offset:offset + 20] = remap_attribute(chunk[offset:offset + 20], mapping)
    return bytes(result)


def add_loader(original, template):
    old_chunks = list(chunks(original))
    new_chunks = list(chunks(template))
    old_strings = strings(next(data for kind, data in old_chunks if kind == STRING_POOL))
    new_strings = strings(next(data for kind, data in new_chunks if kind == STRING_POOL))
    merged = list(old_strings)
    mapping = {}
    for index, value in enumerate(new_strings):
        if value not in merged:
            merged.append(value)
        mapping[index] = merged.index(value)
    resources = [0] * len(merged)
    for kind, data in old_chunks:
        if kind == RESOURCE_MAP:
            ids = struct.unpack('<' + 'I' * ((len(data) - 8) // 4), data[8:])
            resources[:len(ids)] = ids
    for kind, data in new_chunks:
        if kind != RESOURCE_MAP:
            continue
        ids = struct.unpack('<' + 'I' * ((len(data) - 8) // 4), data[8:])
        for index, resource_id in enumerate(ids):
            target = mapping[index]
            if resources[target] not in [0, resource_id]:
                raise ValueError('Conflicting attribute resource ID')
            resources[target] = resource_id
    provider = []
    cleartext = None
    for kind, data in new_chunks:
        if kind not in [START_ELEMENT, END_ELEMENT]:
            continue
        name = new_strings[struct.unpack_from('<I', data, 20)[0]]
        if name == 'provider':
            provider.append(remap_element(data, mapping))
        if name == 'application' and kind == START_ELEMENT:
            attribute_start, attribute_size, count = struct.unpack_from('<HHH', data, 24)
            for index in range(count):
                offset = 16 + attribute_start + index * attribute_size
                attribute = data[offset:offset + 20]
                if new_strings[struct.unpack_from('<I', attribute, 4)[0]] == 'usesCleartextTraffic':
                    cleartext = remap_attribute(attribute, mapping)
    if len(provider) != 2 or cleartext is None:
        raise ValueError('Incomplete provider template')
    output = bytearray()
    for kind, data in old_chunks:
        if kind == STRING_POOL:
            output.extend(string_pool(merged))
            continue
        if kind == RESOURCE_MAP:
            output.extend(struct.pack('<HHI', RESOURCE_MAP, 8, 8 + 4 * len(resources)))
            output.extend(struct.pack('<' + 'I' * len(resources), *resources))
            continue
        if kind in [START_ELEMENT, END_ELEMENT]:
            name = old_strings[struct.unpack_from('<I', data, 20)[0]]
            if name == 'application' and kind == END_ELEMENT:
                output.extend(b''.join(provider))
            if name == 'application' and kind == START_ELEMENT:
                start, size, count = struct.unpack_from('<HHH', data, 24)
                attributes = [data[16 + start + index * size:16 + start + (index + 1) * size]
                              for index in range(count)]
                if any(old_strings[struct.unpack_from('<I', item, 4)[0]] == 'usesCleartextTraffic'
                       for item in attributes):
                    raise ValueError('Baseline already declares a cleartext policy')
                attributes.append(cleartext)
                attributes.sort(key=lambda item: resources[struct.unpack_from('<I', item, 4)[0]])
                rewritten = bytearray(data[:16 + start])
                struct.pack_into('<I', rewritten, 4, len(data) + 20)
                struct.pack_into('<H', rewritten, 28, count + 1)
                for field in [30, 32, 34]:
                    previous = struct.unpack_from('<H', data, field)[0]
                    if previous:
                        offset = 16 + start + (previous - 1) * size
                        original_attribute = data[offset:offset + size]
                        struct.pack_into('<H', rewritten, field, attributes.index(original_attribute) + 1)
                data = bytes(rewritten) + b''.join(attributes)
        output.extend(data)
    return struct.pack('<HHI', 3, 8, 8 + len(output)) + output
