import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseShareParam, shareUrl, getEditKey, storeEditKey, listMine, getAuthor, setAuthor } from '../registry/client.js';

describe('parseShareParam', () => {
  it('reads ?s=<id>', () => expect(parseShareParam('?s=abcd1234')).toBe('abcd1234'));
  it('tolerates @revision (ignored in v1) and uppercase', () => {
    expect(parseShareParam('?s=abcd1234@3')).toBe('abcd1234');
    expect(parseShareParam('?s=ABCD1234')).toBe('abcd1234');
  });
  it('null on absent/malformed', () => {
    expect(parseShareParam('')).toBe(null);
    expect(parseShareParam('?s=short')).toBe(null);
    expect(parseShareParam('?s=../../etc')).toBe(null);
  });
});

describe('shareUrl', () => {
  it('canonical pretty link', () => expect(shareUrl('abcd1234')).toBe('https://groovebox.oyster.to/s/abcd1234'));
});

describe('editKey + author storage (gb-registry-*)', () => {
  beforeEach(() => {
    const store = {};
    vi.stubGlobal('localStorage', {
      getItem: (k) => store[k] ?? null,
      setItem: (k, v) => { store[k] = String(v); },
    });
  });
  it('stores and retrieves per-id edit keys', () => {
    storeEditKey('abcd1234', 'KEY1');
    storeEditKey('efgh5678', 'KEY2');
    expect(getEditKey('abcd1234')).toBe('KEY1');
    expect(getEditKey('efgh5678')).toBe('KEY2');
    expect(getEditKey('nope0000')).toBe(null);
    expect(localStorage.getItem('gb-registry-edit-keys')).toContain('KEY1');
  });
  it('remembers author name', () => {
    expect(getAuthor()).toBe('');
    setAuthor('Henry');
    expect(getAuthor()).toBe('Henry');
    expect(localStorage.getItem('gb-registry-author')).toBe('Henry');
  });
  it('stores name/kind meta; listMine returns newest first', () => {
    let t = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => ++t);   // same-ms publishes must still order
    storeEditKey('abcd1234', 'KEY1', { name: 'Kids', kind: 'song' });
    storeEditKey('efgh5678', 'KEY2', { name: 'amen', kind: 'groove' });
    expect(getEditKey('abcd1234')).toBe('KEY1');
    const mine = listMine();
    expect(mine.map((m) => m.id)).toEqual(['efgh5678', 'abcd1234']);
    expect(mine[1]).toMatchObject({ name: 'Kids', kind: 'song' });
  });
  it('tolerates legacy bare-string values', () => {
    localStorage.setItem('gb-registry-edit-keys', JSON.stringify({ old00000: 'RAWKEY' }));
    expect(getEditKey('old00000')).toBe('RAWKEY');
    expect(listMine()).toEqual([{ id: 'old00000', name: 'old00000', kind: '', at: 0 }]);
    storeEditKey('old00000', 'RAWKEY', { name: 'Named now', kind: 'song' });
    expect(getEditKey('old00000')).toBe('RAWKEY');
    expect(listMine()[0].name).toBe('Named now');
  });
  it('degrades silently without localStorage', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(getEditKey('abcd1234')).toBe(null);
    expect(getAuthor()).toBe('');
    storeEditKey('abcd1234', 'k');   // must not throw
    setAuthor('x');                  // must not throw
  });
});
