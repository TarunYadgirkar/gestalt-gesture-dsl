export { saveSession, loadSession, SessionRecorder } from './session.js';
export { scoreSession, aggregate, PRE_TOLERANCE_MS, POST_TOLERANCE_MS } from './metrics.js';
export type { SessionScore, MatchDetail } from './metrics.js';
export { compareToBaseline, DEFAULT_TOLERANCES, formatRegression } from './regression.js';
export { renderReport } from './report.js';
export type { ReportInput } from './report.js';
