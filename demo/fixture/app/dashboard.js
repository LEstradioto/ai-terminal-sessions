export function attentionSummary(sessions) {
  return sessions.reduce((summary, session) => {
    summary[session.state] = (summary[session.state] || 0) + 1;
    return summary;
  }, {});
}
