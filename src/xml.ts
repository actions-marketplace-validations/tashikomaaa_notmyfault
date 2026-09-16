/**
 * Minimal, forgiving XML parser tailored to JUnit reports.
 *
 * It is not a validating parser: it builds an element tree, decodes entities
 * and CDATA, skips comments, processing instructions and DOCTYPE declarations,
 * and tolerates the kind of malformed output some test reporters produce.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

// Large <system-out> blocks are useless for our purpose; cap what we keep.
const MAX_TEXT_LENGTH = 64 * 1024;

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g;

export function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(ENTITY_RE, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

export function parseXml(input: string): XmlElement {
  const root: XmlElement = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  const length = input.length;
  let i = input.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (i < length) {
    const current = stack[stack.length - 1]!;
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      appendText(current, decodeEntities(input.slice(i)));
      break;
    }
    if (lt > i) appendText(current, decodeEntities(input.slice(i, lt)));

    if (input.startsWith("<!--", lt)) {
      i = skipPast(input, "-->", lt + 4);
    } else if (input.startsWith("<![CDATA[", lt)) {
      const end = input.indexOf("]]>", lt + 9);
      appendText(current, input.slice(lt + 9, end === -1 ? length : end));
      i = end === -1 ? length : end + 3;
    } else if (input.startsWith("<?", lt)) {
      i = skipPast(input, "?>", lt + 2);
    } else if (input.startsWith("<!", lt)) {
      i = skipDeclaration(input, lt);
    } else if (input[lt + 1] === "/") {
      const end = input.indexOf(">", lt + 2);
      const name = input.slice(lt + 2, end === -1 ? length : end).trim();
      // Pop back to the matching element, implicitly closing unclosed children.
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.name === name) {
          stack.length = k;
          break;
        }
      }
      i = end === -1 ? length : end + 1;
    } else {
      i = parseStartTag(input, lt, stack);
    }
  }

  return root;
}

/** Depth-first search for every element with the given name. */
export function findAll(element: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const child of element.children) {
    if (child.name === name) out.push(child);
    findAll(child, name, out);
  }
  return out;
}

function appendText(element: XmlElement, text: string): void {
  if (element.text.length >= MAX_TEXT_LENGTH) return;
  element.text += text.slice(0, MAX_TEXT_LENGTH - element.text.length);
}

function skipPast(input: string, terminator: string, from: number): number {
  const end = input.indexOf(terminator, from);
  return end === -1 ? input.length : end + terminator.length;
}

function skipDeclaration(input: string, lt: number): number {
  // DOCTYPE may embed an internal subset between brackets containing '>'.
  let depth = 0;
  for (let j = lt + 2; j < input.length; j++) {
    const c = input[j];
    if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === ">" && depth <= 0) return j + 1;
  }
  return input.length;
}

function isSpace(c: string | undefined): boolean {
  return c === " " || c === "\n" || c === "\t" || c === "\r";
}

function parseStartTag(input: string, lt: number, stack: XmlElement[]): number {
  const length = input.length;
  let j = lt + 1;
  while (j < length && !isSpace(input[j]) && input[j] !== ">" && input[j] !== "/") j++;

  const element: XmlElement = { name: input.slice(lt + 1, j), attrs: {}, children: [], text: "" };
  let selfClosing = false;

  while (j < length) {
    const c = input[j];
    if (c === ">") {
      j++;
      break;
    }
    if (c === "/" && input[j + 1] === ">") {
      selfClosing = true;
      j += 2;
      break;
    }
    if (isSpace(c)) {
      j++;
      continue;
    }

    const nameStart = j;
    while (
      j < length &&
      input[j] !== "=" &&
      input[j] !== ">" &&
      !isSpace(input[j]) &&
      !(input[j] === "/" && input[j + 1] === ">")
    ) {
      j++;
    }
    const attrName = input.slice(nameStart, j);
    while (j < length && isSpace(input[j])) j++;
    if (input[j] !== "=") {
      if (attrName) element.attrs[attrName] = "";
      continue;
    }
    j++;
    while (j < length && isSpace(input[j])) j++;

    const quote = input[j];
    if (quote === '"' || quote === "'") {
      const end = input.indexOf(quote, j + 1);
      const stop = end === -1 ? length : end;
      element.attrs[attrName] = decodeEntities(input.slice(j + 1, stop));
      j = stop + 1;
    } else {
      const valueStart = j;
      while (j < length && !isSpace(input[j]) && input[j] !== ">") j++;
      element.attrs[attrName] = decodeEntities(input.slice(valueStart, j));
    }
  }

  stack[stack.length - 1]!.children.push(element);
  if (!selfClosing) stack.push(element);
  return j;
}
