export interface ParsedSegment {
  type: 'text' | 'thinking';
  content: string;
}

const OPEN_TAG = '<thinking>';
const CLOSE_TAG = '</thinking>';

export class ThinkingTagParser {
  private buffer = '';
  private insideThinking = false;

  push(chunk: string): ParsedSegment[] {
    this.buffer += chunk;
    return this.drain();
  }

  flush(): ParsedSegment[] {
    const segments: ParsedSegment[] = [];
    if (this.buffer.length > 0) {
      segments.push({type: this.insideThinking ? 'thinking' : 'text', content: this.buffer});
      this.buffer = '';
    }
    return segments;
  }

  // Both modes run the same algorithm; only the tag and the segment type differ.
  private drain(): ParsedSegment[] {
    const segments: ParsedSegment[] = [];

    while (this.buffer.length > 0) {
      const tag = this.insideThinking ? CLOSE_TAG : OPEN_TAG;
      const type: ParsedSegment['type'] = this.insideThinking ? 'thinking' : 'text';

      const tagIdx = this.buffer.indexOf(tag);
      if (tagIdx !== -1) {
        this.emit(segments, type, this.buffer.slice(0, tagIdx));
        this.buffer = this.buffer.slice(tagIdx + tag.length);
        this.insideThinking = !this.insideThinking;
        continue;
      }

      const partialLen = this.partialMatchLength(this.buffer, tag);
      if (partialLen === 0) {
        this.emit(segments, type, this.buffer);
        this.buffer = '';
        continue;
      }

      // The tail could still grow into the tag, so hold it and wait for more.
      const held = this.buffer.length - partialLen;
      this.emit(segments, type, this.buffer.slice(0, held));
      this.buffer = this.buffer.slice(held);
      break;
    }

    return segments;
  }

  // The one place an empty segment is suppressed.
  private emit(segments: ParsedSegment[], type: ParsedSegment['type'], content: string): void {
    if (content.length > 0) {
      segments.push({type, content});
    }
  }

  private partialMatchLength(buffer: string, tag: string): number {
    const maxCheck = Math.min(buffer.length, tag.length - 1);
    for (let len = maxCheck; len >= 1; len--) {
      if (buffer.endsWith(tag.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }
}
