const CONTROL_TOKEN_PATTERN =
  /(?:<[^>]*>|[_/<>-]*[a-z]*(?:start|end|turn|of_turn|ofend)[a-z_<>/-]*)/gi;

function normalizePlainText(text: string) {
  return text.replace(/[ \t\f\v]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function cleanAssistantText(text: string) {
  let cleaned = text
    .replace(/<start_of_turn>/gi, '')
    .replace(/<end_of_turn>/gi, '')
    .replace(/<end_of_of_turn>/gi, '')
    .replace(/<\/?start_of(?:_of)?_turn>?/gi, '')
    .replace(/<\/?end_of(?:_of)?_turn>?/gi, '')
    .replace(/model_turn>/gi, '')
    .replace(/user_turn>/gi, '')
    .replace(/assistant_turn>/gi, '')
    .replace(/\b(?:user|model|assistant)\s*>/gi, '')
    .replace(/\|\s*<tool_call>\s*\|\s*<tool_response>\s*/gi, ' ')
    .replace(/<tool_call>|<tool_response>/gi, ' ')
    .replace(CONTROL_TOKEN_PATTERN, ' ')
    .trim();

  const stopMarkers = [
    '\nuser>',
    '\nmodel>',
    '\nassistant>',
    '\nuser\n',
    '\nmodel\n',
    '\nassistant\n',
    '<start_of_turn>user',
    '<start_of_turn>model',
    '<start_of_turn>assistant',
    '</start_of_turn> user',
    '</start_of_turn> model',
    '</start_of_turn> assistant',
    '</end_of_turn> user',
    '</end_of_turn> model',
    '</end_of_turn> assistant',
    '<start_of',
    '<end_of',
    ' user ',
    ' model ',
  ];

  const lowered = cleaned.toLowerCase();
  let cutIndex = cleaned.length;
  for (const marker of stopMarkers) {
    const index = lowered.indexOf(marker.toLowerCase());
    if (index > 0 && index < cutIndex) {
      cutIndex = index;
    }
  }

  cleaned = cleaned.slice(0, cutIndex);
  const segments = cleaned.split(/(```[\s\S]*?```)/g);
  cleaned = segments
    .map((segment) => {
      if (segment.startsWith('```') && segment.endsWith('```')) {
        return segment.trim();
      }

      return normalizePlainText(segment);
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
  cleaned = cleaned.replace(/\b(?:assistant|model|user)\b\s*$/i, '').trim();

  return cleaned;
}

export function getStreamingPreviewText(text: string) {
  let cleaned = cleanAssistantText(text);
  if (!cleaned) {
    return '';
  }

  const fenceMatches = cleaned.match(/```/g);
  if (fenceMatches && fenceMatches.length % 2 === 1) {
    cleaned = cleaned.slice(0, cleaned.lastIndexOf('```')).trimEnd();
  }

  if (!cleaned) {
    return '';
  }

  if (/[.!?。！？]\s*$/.test(cleaned) || cleaned.endsWith('\n') || cleaned.endsWith('```')) {
    return cleaned;
  }

  const boundaryPattern = /(?:\n\n|\n|[.!?。！？]\s+)/g;
  let stableCutoff = -1;
  for (const match of cleaned.matchAll(boundaryPattern)) {
    stableCutoff = (match.index ?? 0) + match[0].length;
  }

  if (stableCutoff >= 48) {
    return cleaned.slice(0, stableCutoff).trimEnd();
  }

  if (cleaned.length <= 80) {
    return '';
  }

  const lastSpace = cleaned.lastIndexOf(' ');
  if (lastSpace >= 48) {
    return cleaned.slice(0, lastSpace).trimEnd();
  }

  return '';
}
