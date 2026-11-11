#!/usr/bin/env python3
"""Verificador independiente del .pck (implementado desde el lector de OMI-Filetype-Library).
Uso: python3 test/verify.py fichero.pck"""
import struct, sys

TYPES = {0: 'SkinFile', 1: 'CapeFile', 2: 'TextureFile', 3: 'UIDataFile', 4: 'InfoFile',
         5: 'TexturePackInfoFile', 6: 'LocalisationFile', 7: 'GameRulesFile', 8: 'AudioFile',
         9: 'ColourTableFile', 10: 'GameRulesHeader', 11: 'SkinDataFile', 12: 'ModelsFile',
         13: 'BehavioursFile', 14: 'MaterialFile'}


class R:
    def __init__(self, data, le):
        self.d, self.o, self.le = data, 0, le
        self.e = '<' if le else '>'

    def i32(self):
        v = struct.unpack_from(self.e + 'i', self.d, self.o)[0]
        self.o += 4
        return v

    def raw(self, n):
        v = self.d[self.o:self.o + n]
        if len(v) != n:
            raise ValueError('EOF')
        self.o += n
        return v

    def string(self):
        n = self.i32()
        if n < 0 or n > 1 << 20:
            raise ValueError('bad len %d' % n)
        b = self.raw(n * 2)
        self.i32()  # padding
        codec = 'utf-16-le' if self.le else 'utf-16-be'
        return b.decode(codec, 'replace').split('\x00')[0]


def parse(data, le):
    r = R(data, le)
    ptype = r.i32()
    if ptype < 3 or ptype > 0x00ffffff:
        raise ValueError('pckType %d' % ptype)
    lut = [None] * r.i32()
    for _ in range(len(lut)):
        i = r.i32()
        lut[i] = r.string()
    xml = r.i32() if 'XMLVERSION' in lut else 0
    entries = [None] * r.i32()
    for i in range(len(entries)):
        entries[i] = (r.i32(), r.i32(), r.string().replace('\\', '/'))
    assets = []
    for size, atype, name in entries:
        params = {}
        for _ in range(r.i32()):
            k = lut[r.i32()]
            params[k] = r.string()
        assets.append({'name': name, 'type': atype, 'size': size,
                       'params': params, 'data': r.raw(size)})
    if r.o != len(data):
        raise ValueError('sobran %d bytes' % (len(data) - r.o))
    return {'type': ptype, 'xml': xml, 'le': le, 'assets': assets}


def main(path):
    data = open(path, 'rb').read()
    for le in (False, True):
        try:
            p = parse(data, le)
            break
        except Exception as e:
            err = e
    else:
        sys.exit('NO es un PCK válido: %s' % err)

    print('fichero      : %s (%d bytes)' % (path, len(data)))
    print('pckType      : %d' % p['type'])
    print('endianness   : %s' % ('little (PS4/Vita/Switch)' if p['le'] else 'big (PS3/X360/WiiU)'))
    print('XMLVERSION   : %d' % p['xml'])
    print('assets       : %d' % len(p['assets']))
    for a in p['assets']:
        print('\n  [%2d] %-24s tipo %d (%s)  %d bytes' %
              (p['assets'].index(a), a['name'], a['type'], TYPES.get(a['type'], '?'), a['size']))
        if a['name'].lower().endswith('.png'):
            sig = a['data'][:8]
            ok = sig == b'\x89PNG\r\n\x1a\n'
            print('        PNG: %s, %d×%d' % ('OK' if ok else 'FIRMA INVÁLIDA',
                  struct.unpack('>I', a['data'][16:20])[0], struct.unpack('>I', a['data'][20:24])[0]))
        for k, v in a['params'].items():
            print('        %-14s = %s' % (k, v))
    print('\nOK: estructura válida y sin bytes sobrantes')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'test/out/Mi Pack PS3.pck')
