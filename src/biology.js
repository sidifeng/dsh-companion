// L1：只接收经校验的结构化评价，不读取原文、不生成提示词。
// 参数是可验证的聊天工程约束，不是对生物或意识机制的科学还原。
export const HOUR = 3600000;
export const clamp = (x, low = 0, high = 1) => Math.max(low, Math.min(high, Number.isFinite(x) ? x : low));
const fade = (value, elapsed, halfLife) => value * Math.pow(0.5, elapsed / halfLife);
const dayOf = now => Math.floor((now + 8 * HOUR) / (24 * HOUR));

export function initialBiology(profile = {}, now = Date.now()) {
  return { version: 1, at: now, lastEventAt: 0, lastAffectAt: 0, lastGrowthAt: 0,
    familiarity: clamp((profile.familiarity ?? 0) / 100), trust: 0.2,
    closeness: Math.min(0.35, (profile.familiarity ?? 0) / 100), conflict: 0,
    valence: 0, residue: 0, opponent: 0, arousal: 0.1, stress: 0, load: 0,
    day: dayOf(now), budget: { familiarity: 0, trust: 0, closeness: 0, affect: 0 },
    encounters: 0, activeDays: 0, lastDay: -1, strategy: 'natural',
    strategies: {}, feedbackDays: [], warmth: 0.5, expressiveness: 0.5,
    learningSteps: 0, lastLearningDay: -1 };
}

export function advanceBiology(state, now) {
  const s = structuredClone(state); const elapsed = Math.max(0, now - s.at);
  // 恢复底线不会被负荷关闭；离线时间一次计算，重启不补发事件。
  s.valence = fade(s.valence, elapsed, 3 * HOUR);
  s.residue = fade(s.residue, elapsed, 8 * HOUR);
  s.opponent = fade(s.opponent, elapsed, HOUR);
  s.arousal = 0.1 + fade(s.arousal - 0.1, elapsed, 2 * HOUR);
  s.stress = fade(s.stress, elapsed, (2 + 2 * s.load) * HOUR);
  s.load = fade(s.load, elapsed, 72 * HOUR);
  s.conflict = fade(s.conflict, elapsed, 36 * HOUR);
  s.at = Math.max(s.at, now);
  if (dayOf(s.at) !== s.day) { s.day = dayOf(s.at); s.budget = { familiarity: 0, trust: 0, closeness: 0, affect: 0 }; }
  // trust/closeness/familiarity 不因缺席衰减；不计算催促用户的“想念值”。
  return s;
}

function limitedChange(s, field, delta, limit) {
  const amount = Math.min(Math.abs(delta), Math.max(0, limit - s.budget[field]));
  s[field] = clamp(s[field] + Math.sign(delta) * amount); s.budget[field] += amount;
}

function learnStrategy(s, a, adaptive) {
  if (a.kind !== 'feedback' || !a.feedback || !s.lastEventAt) return;
  const key = s.strategy; const score = s.strategies[key] ?? { good: 0, bad: 0 };
  score[a.feedback === 'helpful' ? 'good' : 'bad'] += 1;
  score.days = [...new Set([...(score.days ?? []), s.day])].slice(-30);
  s.strategies[key] = score;
  s.feedbackDays = [...new Set([...s.feedbackDays, s.day])].slice(-30);
  const total = score.good + score.bad;
  // 默认不学习。明确反馈达到跨日门槛才移动，单日最多一步，参数始终有界。
  if (!adaptive || total < 8 || score.days.length < 3 || s.lastLearningDay === s.day) return;
  const target = score.good / total;
  s.warmth = clamp(s.warmth + clamp(0.05 * (target - s.warmth), -0.01, 0.01), 0.35, 0.65);
  s.expressiveness = clamp(s.expressiveness + clamp(0.03 * (target - s.expressiveness), -0.01, 0.01), 0.35, 0.65);
  s.lastLearningDay = s.day; s.learningSteps += 1;
}

function strategy(s, a) {
  if (a.kind === 'boundary') return 'respect-space';
  if (a.kind === 'conflict' || a.kind === 'repair') return 'repair';
  if (a.kind === 'distress') return 'attentive';
  if (s.stress > 0.55 || s.load > 0.35) return 'steady';
  if (a.kind === 'celebration') return 'light';
  const choices = ['natural', 'gentle'];
  const score = key => { const r = s.strategies[key]; return r ? (r.good + 2) / (r.good + r.bad + 4) - 0.05 : 0.45; };
  return choices.sort((a, b) => score(b) - score(a))[0];
}

export function updateBiology(previous, appraisal, now, { adaptive = false, repeated = false } = {}) {
  const s = advanceBiology(previous, now);
  if (now < previous.at || repeated) return { state: s, applied: false };
  const a = appraisal; const strength = clamp(a.intensity) * clamp(a.confidence);
  const growth = !s.lastGrowthAt || now - s.lastGrowthAt >= 30 * 60000;
  if (growth) {
    // 普通互动可增加熟悉度，但不把“披露隐私”或消息数量当信任证据。
    limitedChange(s, 'familiarity', 0.004, 0.02); s.lastGrowthAt = now;
    if (['warmth', 'shared-interest', 'reliability', 'repair'].includes(a.kind)) {
      limitedChange(s, 'closeness', 0.004 * strength, 0.016);
      limitedChange(s, 'trust', (a.kind === 'reliability' ? 0.004 : 0.002) * strength, 0.012);
    }
    if (a.kind === 'conflict') limitedChange(s, 'trust', -0.003 * strength, 0.012);
    if (s.lastDay !== s.day) { s.activeDays += 1; s.lastDay = s.day; }
  }
  const affect = (!s.lastAffectAt || now - s.lastAffectAt >= 5 * 60000) && s.budget.affect < 12;
  if (affect) {
    const impulses = { warmth: 0.35, 'shared-interest': 0.25, reliability: 0.25, repair: 0.15,
      conflict: -0.4, distress: -0.12, celebration: 0.4, boundary: 0, feedback: 0, neutral: 0 };
    const importance = 0.8 + 0.2 * s.closeness;
    const impulse = (impulses[a.kind] ?? 0) * strength * importance;
    s.valence = clamp(0.75 * s.valence + 0.25 * impulse, -0.45, 0.45);
    s.residue = clamp(0.85 * s.residue + 0.15 * s.valence, -0.25, 0.25);
    if (strength >= 0.75) s.opponent = -0.02 * Math.sign(impulse);
    s.arousal = clamp(0.8 * s.arousal + 0.2 * strength, 0.1, 0.75);
    const pressure = a.kind === 'conflict' ? 0.18 : a.kind === 'distress' ? 0.04 : a.kind === 'repair' ? -0.14 : -0.025;
    s.stress = clamp(s.stress + pressure * strength, 0, 0.75);
    if (s.stress > 0.55) s.load = clamp(s.load + 0.01 * (s.stress - 0.55) * (1 - s.load), 0, 0.6);
    if (a.kind === 'conflict') s.conflict = clamp(s.conflict + 0.08 * strength, 0, 0.75);
    if (a.kind === 'repair') s.conflict = Math.max(0, s.conflict - 0.12 * strength);
    s.lastAffectAt = now; s.budget.affect += 1;
    learnStrategy(s, a, adaptive);
  }
  s.strategy = strategy(s, a); s.lastEventAt = now; s.encounters += 1;
  return { state: s, applied: growth || affect };
}

// L2 只把已有状态翻译成表达提示；不反写 L1，不制造真实主观感受。
export function expressionState(state, recallBias = 0) {
  const valence = clamp(0.75 * state.valence + 0.25 * state.residue + state.opponent + clamp(recallBias, -0.04, 0.04), -0.5, 0.5);
  const familiarity = state.familiarity < 0.12 ? '初识，温和自然' : state.familiarity < 0.4 ? '逐渐熟悉，可以接共同话题' : '相处较久，可以适度默契和轻松玩笑';
  return { familiarity, tone: valence > 0.06 ? '略轻快' : valence < -0.06 ? '稍沉静但友善' : '平稳温和',
    trust: state.trust < 0.3 ? '信任仍在缓慢积累' : state.trust < 0.6 ? '已有一些可靠互动' : '有长期可靠互动依据',
    closeness: state.closeness < 0.3 ? '保留自然距离' : '可自然接续共同经历',
    strategy: state.strategy, pace: state.stress > 0.55 ? '简洁、平稳，仍认真回应' : '跟随当前话题',
    expressionStrength: Math.round(state.expressiveness * 100) / 100, warmth: Math.round(state.warmth * 100) / 100 };
}
