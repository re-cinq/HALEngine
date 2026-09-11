# HAL Engine thinking tag parser

| Field  | Value       |
| ------ | ----------- |
| Issue  | n/a         |
| Status | In Progress |

A model wraps its internal reasoning in `<thinking>...</thinking>`, and that text arrives split across streaming chunks at arbitrary offsets. A tag can be cut in half — `<think` ending one chunk and `ing>` opening the next — so a parser deciding chunk by chunk will either leak half a tag into user-facing text or swallow a bracket that was never a tag at all. `ThinkingTagParser` is the stateful buffer that makes chunk boundaries invisible: it holds back only what could still grow into a tag, and emits everything else at once so streaming stays responsive.

## Segments

`push` takes a chunk and returns the segments that became certain during it.

```ts
interface ParsedSegment {
  type: 'text' | 'thinking';
  content: string;
}
```

- Text with no tag in it is one text segment ([validated by: returns plain text as one text segment](../../src/infrastructure/parsers/thinkingTagParser.test.ts#L38)).
- A complete pair splits into the text before it, the thinking between, and the text after ([validated by: splits text, thinking and trailing text around a complete tag pair](../../src/infrastructure/parsers/thinkingTagParser.test.ts#L42)).
- Several blocks in one chunk each produce their own pair, alternating text and thinking ([validated by: handles several thinking blocks in one chunk](../../src/infrastructure/parsers/thinkingTagParser.test.ts#L61)).
- A tag opening at the very start produces no leading empty text segment ([validated by: emits no empty text segment when the tag opens at the very start](../../src/infrastructure/parsers/thinkingTagParser.test.ts#L50)).
- A tag closed immediately produces no empty thinking segment, and the text either side stays two separate text segments rather than merging, because the parser emits as it goes and never looks back ([validated by: emits no empty thinking segment for an immediately closed tag](../../src/infrastructure/parsers/thinkingTagParser.test.ts#L54)).

## What is not a tag

- A lone angle bracket that never grows into a tag is ordinary text, so prose containing `2 < 3 and 4 > 1` survives intact ([validated by: treats a lone angle bracket that never becomes a tag as text](../../src/infrastructure/parsers/thinkingTagParser.test.ts#L71)).
- A bracket withheld at a chunk boundary is released as text the moment the next chunk proves it cannot be a tag ([validated by: releases a withheld bracket as text once it cannot be a tag](../../src/infrastructure/parsers/thinkingTagParser.test.ts#L108)).

## Chunk boundaries

The tail of the buffer is withheld while it is still a prefix of the tag being looked for; everything before that tail is emitted immediately.

- A chunk ending in a partial opening tag emits the text before it and holds the rest ([validated by: withholds the part that could still become an opening tag](../../src/infrastructure/parsers/thinkingTagParser.test.ts#L77)).
- A chunk that is entirely a partial opening tag emits nothing ([validated by: returns nothing when the whole chunk could still become an opening tag](../../src/infrastructure/parsers/thinkingTagParser.test.ts#L83)).
- Once a later chunk completes the split tag, the content after it is emitted as thinking ([validated by: emits the thinking content once the opening tag completes](../../src/infrastructure/parsers/thinkingTagParser.test.ts#L94)).
- Inside a thinking block the same algorithm runs against the closing tag, with `thinking` as the segment type: a chunk ending in a partial closing tag emits the thinking before it and holds the rest ([validated by: withholds the part that could still become a closing tag](../../src/infrastructure/parsers/thinkingTagParser.test.ts#L101)).
- A chunk that is entirely a partial closing tag emits nothing ([validated by: returns nothing when the whole chunk could still become a closing tag](../../src/infrastructure/parsers/thinkingTagParser.test.ts#L87)).
- Chunking is not observable in the result: joining same-type neighbours, the segments are identical at every chunk size from one character to the whole input ([validated by: produces the same joined segments at every chunk size](../../src/infrastructure/parsers/thinkingTagParser.test.ts#L115)).

## flush

- `flush` returns nothing when the buffer is empty ([validated by: returns nothing when the buffer is empty](../../src/infrastructure/parsers/thinkingTagParser.test.ts#L125)).
- It emits a withheld partial tag as content rather than dropping it, because at end of stream those characters were never a tag and are the model's last words ([validated by: emits a withheld partial tag as content rather than dropping it](../../src/infrastructure/parsers/thinkingTagParser.test.ts#L132)).
- Inside a thinking block that never closed, the remainder is labelled `thinking` ([validated by: labels the remainder thinking when a thinking block never closed](../../src/infrastructure/parsers/thinkingTagParser.test.ts#L139)).
- It clears the buffer, so a second flush returns nothing ([validated by: clears the buffer, so a second flush returns nothing](../../src/infrastructure/parsers/thinkingTagParser.test.ts#L146)).
- It does not reset the mode: a parser flushed inside a thinking block is still inside one, and later pushes are still thinking ([validated by: leaves the parser inside thinking, so later pushes stay thinking](../../src/infrastructure/parsers/thinkingTagParser.test.ts#L154)).

### Rationale

Holding back only the possible-tag tail, rather than buffering until a tag resolves, is what keeps streaming responsive. The common case is a chunk with no bracket in it, which is emitted whole and immediately. The cost is that a caller sees text split at arbitrary points, which is why the suite compares two chunkings only after joining same-type neighbours.

Flush surrenders content instead of discarding it. Both alternatives are worse: dropping a withheld partial tag loses the model's last words, and holding it forever means an unclosed block silently truncates the response. Leaving the mode alone at flush is the matching choice, because flush ends a stream rather than the parser.
