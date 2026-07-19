// Shared "what counts as a number" pattern between highlightNumbers
// (AiSummaryCard) and parseCiteBindings, so the highlighter and the citation
// parser can never drift apart on where a number starts and ends.
export const NUMBER_PATTERN = /(\$[\d,]+(?:\.\d+)?[KMBkmb]?|\d+(?:\.\d+)?%)/g;
