// The two system additions every generation lane puts in front of the
// canvas-compiled context. One copy, read by the proxy (server.mjs), the
// Workers function, the browser-direct lane and the follow-up preview, so
// what the preview shows is what the model is sent.

// Every generation: models default to their training-cutoff sense of "now"
// (bad for temporal questions and search decisions), drift into English on
// weak models, and would otherwise echo the canvas' provenance markers back
// into answers.
export function baseDirective(date = new Date()) {
  return [
    `Current date: ${date.toISOString().slice(0, 10)}.`,
    'Respond in the language of the latest user message unless asked otherwise.',
    'Bracketed markers such as [Note], [Reference: …], [Link snapshot: …], [Important]…[/Important] and [Stale: …] are provenance labels attached to your context by the canvas. Use them to judge where information came from and how much to trust it; never repeat the markers themselves in your answer.',
  ].join(' ');
}

// Proxy and Workers lanes, when the model is given search tools: synthesize
// after searching, with citation numbers that match THIS answer's search
// results (earlier messages may carry their own [n] citations).
export const TOOL_DIRECTIVE = [
  'Tools are AVAILABLE, not mandatory: first decide whether your own knowledge answers the question. Conceptual, definitional, reasoning and creative questions must be answered DIRECTLY, with no tool calls. Search only when the answer depends on current events, specific verifiable facts you are unsure of, or literature citations — or when the user explicitly asks you to look something up.',
  'After using any search tool, you MUST follow up with a complete answer that SYNTHESIZES the results in your own words — analyze and conclude, never just list the results.',
  "Cite sources inline as [n], using EXACTLY the bracket numbers shown in this turn's search results (they always start at [1]). Ignore any citation numbers appearing in earlier conversation messages — they refer to different sources.",
  'If the search results are not actually relevant to the question, say so explicitly and answer from your own knowledge instead of forcing citations.',
  'Never end your turn immediately after a search.',
].join(' ');
