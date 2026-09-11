import {ThinkingTagParser} from './thinkingTagParser.js';
import type {ParsedSegment} from './thinkingTagParser.js';

// A tag can arrive split across any two chunks; no segment is ever emitted empty.

const parseWhole = (input: string): ParsedSegment[] => {
  const parser = new ThinkingTagParser();
  return [...parser.push(input), ...parser.flush()];
};

const parseInChunks = (input: string, size: number): ParsedSegment[] => {
  const parser = new ThinkingTagParser();
  const segments: ParsedSegment[] = [];
  for (let at = 0; at < input.length; at += size) {
    segments.push(...parser.push(input.slice(at, at + size)));
  }
  segments.push(...parser.flush());
  return segments;
};

// Joining same-type neighbours is what makes two different chunkings comparable.
const joinAdjacent = (segments: ParsedSegment[]): ParsedSegment[] =>
  segments.reduce<ParsedSegment[]>((joined, segment) => {
    const last = joined[joined.length - 1];
    if (last?.type === segment.type) {
      last.content += segment.content;
      return joined;
    }

    joined.push({...segment});
    return joined;
  }, []);

const MIXED = 'intro<thinking>pondering</thinking>answer<thinking>more</thinking>tail';

describe('ThinkingTagParser', () => {
  describe('a single push', () => {
    it('returns plain text as one text segment', () => {
      expect(parseWhole('just words')).toEqual([{type: 'text', content: 'just words'}]);
    });

    it('splits text, thinking and trailing text around a complete tag pair', () => {
      expect(parseWhole('before<thinking>hidden</thinking>after')).toEqual([
        {type: 'text', content: 'before'},
        {type: 'thinking', content: 'hidden'},
        {type: 'text', content: 'after'},
      ]);
    });

    it('emits no empty text segment when the tag opens at the very start', () => {
      expect(parseWhole('<thinking>hidden</thinking>')).toEqual([{type: 'thinking', content: 'hidden'}]);
    });

    it('emits no empty thinking segment for an immediately closed tag', () => {
      expect(parseWhole('a<thinking></thinking>b')).toEqual([
        {type: 'text', content: 'a'},
        {type: 'text', content: 'b'},
      ]);
    });

    it('handles several thinking blocks in one chunk', () => {
      expect(parseWhole(MIXED)).toEqual([
        {type: 'text', content: 'intro'},
        {type: 'thinking', content: 'pondering'},
        {type: 'text', content: 'answer'},
        {type: 'thinking', content: 'more'},
        {type: 'text', content: 'tail'},
      ]);
    });

    it('treats a lone angle bracket that never becomes a tag as text', () => {
      expect(parseWhole('2 < 3 and 4 > 1')).toEqual([{type: 'text', content: '2 < 3 and 4 > 1'}]);
    });
  });

  describe('a tag split across chunks', () => {
    it('withholds the part that could still become an opening tag', () => {
      const parser = new ThinkingTagParser();

      expect(parser.push('hel<think')).toEqual([{type: 'text', content: 'hel'}]);
    });

    it('returns nothing when the whole chunk could still become an opening tag', () => {
      expect(new ThinkingTagParser().push('<thi')).toEqual([]);
    });

    it('returns nothing when the whole chunk could still become a closing tag', () => {
      const parser = new ThinkingTagParser();
      parser.push('<thinking>');

      expect(parser.push('</th')).toEqual([]);
    });

    it('emits the thinking content once the opening tag completes', () => {
      const parser = new ThinkingTagParser();
      parser.push('hel<think');

      expect(parser.push('ing>abc')).toEqual([{type: 'thinking', content: 'abc'}]);
    });

    it('withholds the part that could still become a closing tag', () => {
      const parser = new ThinkingTagParser();
      parser.push('<thinking>');

      expect(parser.push('ab</think')).toEqual([{type: 'thinking', content: 'ab'}]);
    });

    it('releases a withheld bracket as text once it cannot be a tag', () => {
      const parser = new ThinkingTagParser();
      parser.push('a<');

      expect(parser.push('b')).toEqual([{type: 'text', content: '<b'}]);
    });

    it('produces the same joined segments at every chunk size', () => {
      const whole = joinAdjacent(parseWhole(MIXED));
      const sizes = Array.from({length: MIXED.length}, (_, index) => index + 1);
      const byChunkSize = sizes.map(size => joinAdjacent(parseInChunks(MIXED, size)));

      expect(byChunkSize).toEqual(sizes.map(() => whole));
    });
  });

  describe('flush', () => {
    it('returns nothing when the buffer is empty', () => {
      const parser = new ThinkingTagParser();
      parser.push('all consumed');

      expect(parser.flush()).toEqual([]);
    });

    it('emits a withheld partial tag as content rather than dropping it', () => {
      const parser = new ThinkingTagParser();
      parser.push('text<think');

      expect(parser.flush()).toEqual([{type: 'text', content: '<think'}]);
    });

    it('labels the remainder thinking when a thinking block never closed', () => {
      const parser = new ThinkingTagParser();
      parser.push('<thinking>unfinished</think');

      expect(parser.flush()).toEqual([{type: 'thinking', content: '</think'}]);
    });

    it('clears the buffer, so a second flush returns nothing', () => {
      const parser = new ThinkingTagParser();
      parser.push('text<think');
      parser.flush();

      expect(parser.flush()).toEqual([]);
    });

    it('leaves the parser inside thinking, so later pushes stay thinking', () => {
      const parser = new ThinkingTagParser();
      parser.push('<thinking>a</think');
      parser.flush();

      expect(parser.push('more')).toEqual([{type: 'thinking', content: 'more'}]);
    });
  });
});
