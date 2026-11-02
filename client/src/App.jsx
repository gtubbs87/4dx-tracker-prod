import React, { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, ReferenceLine,
} from 'recharts';
import {
  Target, Users, LayoutGrid, Settings, ChevronRight, ChevronDown, Plus, Check, X, AlertTriangle,
  Calendar, Radio, Trash2, Coffee, LogOut, CheckCircle2, PauseCircle, RotateCcw, History, BellRing, Home,
} from 'lucide-react';
import { api } from './api.js';
import { oktaLoginUrl, logout, fetchMe } from './auth.js';
import { trackPageView, trackEvent } from './analytics.js';

// Tab id -> human-readable page name for GA page_view events. This is a
// single-page app with no real URL routing between tabs, so page views are
// sent manually on tab change rather than relying on gtag's URL-based default.
const TAB_LABELS = { home: 'Home', myweek: 'My Week', team: 'Scoreboard', leadership: 'Org Analytics', setup: 'WIG Administration' };

const COLORS = {
  ink: '#12181F', panel: '#1B232D', panelAlt: '#232C36', line: '#2E3944',
  gold: '#E8A73D', green: '#4FAE7C', red: '#D9614F', textHi: '#EDEFF2', textMuted: '#8B96A3',
};

// Org hierarchy, lowest to highest. Everyone except `ic` (Individual
// Contributor) gets full org-wide admin access — see requireRole.js on the
// server for the matching gate.
const ROLE_RANK = { ic: 0, manager: 1, director: 2, vp: 3, svp: 4, exec: 5 };

function isoWeekMonday(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  return d.toISOString().slice(0, 10);
}
function prevWeekMonday(weekStart) {
  const d = new Date(weekStart);
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

/* ---------- design atoms (same look as the prototype) ---------- */
function Gauge({ score, size = 64 }) {
  const bandOf = (s) => (s === null || s === undefined ? COLORS.textMuted : s >= 90 ? COLORS.green : s >= 70 ? COLORS.gold : COLORS.red);
  const color = bandOf(score);
  const r = size / 2 - 6, circ = 2 * Math.PI * r;
  const pct = score === null || score === undefined ? 0 : score / 100;
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke={COLORS.line} strokeWidth="6" fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth="6" fill="none"
          strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)} strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: 'stroke-dashoffset .6s ease' }} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, fontSize: size * 0.26, color: COLORS.textHi }}>
        {score === null || score === undefined ? '–' : score}
      </div>
    </div>
  );
}
function Pill({ children, color }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999,
    fontSize: 12, fontWeight: 600, color, background: color + '22', fontFamily: 'Inter' }}>{children}</span>;
}
function Btn({ children, onClick, variant = 'primary', style, disabled, type = 'button' }) {
  const base = { fontFamily: 'Inter', fontWeight: 600, fontSize: 13, padding: '9px 16px', borderRadius: 8,
    border: '1px solid transparent', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
    display: 'inline-flex', alignItems: 'center', gap: 6, transition: 'all .15s' };
  const variants = {
    primary: { background: COLORS.gold, color: '#1A1200' },
    ghost: { background: 'transparent', color: COLORS.textHi, border: `1px solid ${COLORS.line}` },
    danger: { background: 'transparent', color: COLORS.red, border: `1px solid ${COLORS.red}55` },
  };
  return <button type={type} onClick={onClick} disabled={disabled} style={{ ...base, ...variants[variant], ...style }}>{children}</button>;
}
function Input(props) {
  return <input {...props} style={{ fontFamily: 'Inter', fontSize: 13, padding: '9px 11px', borderRadius: 7,
    border: `1px solid ${COLORS.line}`, background: COLORS.ink, color: COLORS.textHi, outline: 'none',
    width: '100%', boxSizing: 'border-box', ...props.style }} />;
}
function Select(props) {
  return <select {...props} style={{ fontFamily: 'Inter', fontSize: 13, padding: '9px 11px', borderRadius: 7,
    border: `1px solid ${COLORS.line}`, background: COLORS.ink, color: COLORS.textHi, outline: 'none',
    width: '100%', boxSizing: 'border-box', ...props.style }}>{props.children}</select>;
}
function Card({ children, style }) {
  return <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 12, padding: 18, ...style }}>{children}</div>;
}
function Label({ children }) {
  return <div style={{ fontFamily: 'Inter', fontSize: 11, fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase', color: COLORS.textMuted, marginBottom: 6 }}>{children}</div>;
}
function PageHeader({ eyebrow, title, sub }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontFamily: 'Inter', fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: COLORS.gold, marginBottom: 4 }}>{eyebrow}</div>
      <div style={{ fontFamily: "'Fraunces', serif", fontSize: 28, fontWeight: 600, letterSpacing: -0.4 }}>{title}</div>
      {sub && <div style={{ color: COLORS.textMuted, fontSize: 13.5, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}
function EmptyState({ title, body }) {
  return (
    <Card style={{ textAlign: 'center', padding: '40px 20px', color: COLORS.textMuted }}>
      <div style={{ fontFamily: "'Fraunces', serif", fontSize: 18, color: COLORS.textHi, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13.5 }}>{body}</div>
    </Card>
  );
}
function Shell({ children }) {
  return <div style={{ background: COLORS.ink, color: COLORS.textHi, height: '100vh', width: '100%', fontFamily: 'Inter, sans-serif' }}>{children}</div>;
}
function Brand() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
      <div style={{ width: 30, height: 30, borderRadius: 8, background: COLORS.gold, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#1A1200', fontWeight: 700, fontSize: 12.5 }}>4DX</div>
      <div style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 17, letterSpacing: -0.3 }}>Execution</div>
    </div>
  );
}
function NavItem({ active, icon: Icon, label, onClick }) {
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px', borderRadius: 8, cursor: 'pointer',
      background: active ? COLORS.panelAlt : 'transparent', color: active ? COLORS.textHi : COLORS.textMuted, fontFamily: 'Inter', fontSize: 13.5, fontWeight: 600 }}>
      <Icon size={16} /> {label}
    </div>
  );
}

/* ================= APP ================= */
export default function App() {
  const [me, setMe] = useState(null);
  const [meLoaded, setMeLoaded] = useState(false);
  const [tab, setTab] = useState('home');
  const [isMobile, setIsMobile] = useState(window.innerWidth < 720);
  const [teams, setTeams] = useState([]);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 720);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const loadMe = useCallback(async () => {
    try {
      const user = await fetchMe();
      setMe(user);
    } catch (e) {
      setMe(null);
    } finally {
      setMeLoaded(true);
    }
  }, []);

  useEffect(() => { loadMe(); }, [loadMe]);
  useEffect(() => { if (me) api.get('/api/teams').then(setTeams).catch(() => {}); }, [me]);
  useEffect(() => {
    if (!meLoaded) return;
    trackPageView(me ? (TAB_LABELS[tab] || tab) : 'Login');
  }, [meLoaded, me, tab]);

  if (!meLoaded) return <Shell><div style={{ padding: 60, textAlign: 'center', color: COLORS.textMuted }}>Loading…</div></Shell>;
  if (!me) return <Shell><Login /></Shell>;

  const myTeam = teams.find((t) => t.id === me.team_id);
  const tabs = [
    { id: 'home', label: 'Home', icon: Home },
    { id: 'myweek', label: 'My Week', icon: Radio },
    { id: 'team', label: 'Scoreboard', icon: Target },
    { id: 'leadership', label: 'Org Analytics', icon: LayoutGrid },
    { id: 'setup', label: 'WIG Administration', icon: Settings },
  ];

  return (
    <Shell>
      <div style={{ display: 'flex', height: '100%' }}>
        {!isMobile && (
          <div style={{ width: 210, borderRight: `1px solid ${COLORS.line}`, padding: '20px 14px', display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0, height: '100%', boxSizing: 'border-box', overflowY: 'auto' }}>
            <Brand />
            <div style={{ height: 18 }} />
            {tabs.map((t) => <NavItem key={t.id} active={tab === t.id} icon={t.icon} label={t.label} onClick={() => setTab(t.id)} />)}
            <div style={{ flex: 1 }} />
            <div onClick={() => { trackEvent('logout'); logout(); setMe(null); }} style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'Inter', fontSize: 12, color: COLORS.textMuted, cursor: 'pointer', padding: '8px 10px' }}>
              <LogOut size={13} /> {me.first_name} {me.last_name} · sign out
            </div>
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {isMobile && <div style={{ padding: '16px 16px 8px' }}><Brand /></div>}
          <div style={{ flex: 1, minHeight: 0, padding: isMobile ? '8px 14px 90px' : '24px 28px', overflowY: 'auto' }}>
            {tab === 'home' && <HomePage me={me} team={myTeam} onNavigate={setTab} />}
            {tab === 'myweek' && <MyWeek me={me} team={myTeam} />}
            {tab === 'team' && <TeamScoreboard teams={teams} defaultTeamId={myTeam?.id} me={me} />}
            {tab === 'leadership' && <Leadership teams={teams} me={me} />}
            {tab === 'setup' && <Setup teams={teams} onTeamsChanged={() => api.get('/api/teams').then(setTeams)} me={me} />}
          </div>
          {isMobile && (
            <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: COLORS.panel, borderTop: `1px solid ${COLORS.line}`, display: 'flex', padding: '6px 4px', paddingBottom: 'calc(6px + env(safe-area-inset-bottom))' }}>
              {tabs.map((t) => (
                <div key={t.id} onClick={() => setTab(t.id)} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '6px 0', cursor: 'pointer', color: tab === t.id ? COLORS.gold : COLORS.textMuted }}>
                  <t.icon size={18} />
                  <span style={{ fontFamily: 'Inter', fontSize: 10, fontWeight: 600 }}>{t.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}

/* ---------- Login ---------- */
function Login() {
  return (
    <div style={{ maxWidth: 420, margin: '0 auto', padding: '12vh 20px 20px' }}>
      <Brand />
      <div style={{ height: 28 }} />
      <div style={{ fontFamily: "'Fraunces', serif", fontSize: 26, fontWeight: 600, marginBottom: 6 }}>Sign in</div>
      <div style={{ color: COLORS.textMuted, fontSize: 13.5, marginBottom: 22 }}>Sign in with your company Okta account.</div>
      <Btn onClick={() => { trackEvent('login_attempt', { method: 'okta' }); window.location.href = oktaLoginUrl(); }} style={{ width: '100%', justifyContent: 'center' }}>
        Continue with Okta <ChevronRight size={15} />
      </Btn>
    </div>
  );
}

/* ---------- Home ---------- */
function HomePage({ me, team, onNavigate }) {
  const wk = isoWeekMonday();
  const pwk = prevWeekMonday(wk);
  const mo = wk.slice(0, 7);
  const isManager = (ROLE_RANK[me?.role] ?? 0) >= ROLE_RANK.manager;

  const [session, setSession] = useState(null);
  const [prevSession, setPrevSession] = useState(null);
  const [wig, setWig] = useState(null);
  const [metrics, setMetrics] = useState([]);
  const [history, setHistory] = useState(null);
  const [userTrend, setUserTrend] = useState(null);
  const [rollup, setRollup] = useState(null);
  const [attainment, setAttainment] = useState(null);
  const [teamHistory, setTeamHistory] = useState(null);
  const [reportsPending, setReportsPending] = useState(null);

  const load = useCallback(async () => {
    if (!team) return;
    const [s, p, w, r, a] = await Promise.all([
      api.get(`/api/sessions/${team.id}/${wk}`),
      api.get(`/api/sessions/${team.id}/${pwk}`),
      api.get(`/api/wigs/${team.id}`),
      api.get(`/api/analytics/rollup/${team.id}`),
      api.get(`/api/analytics/team/${team.id}/attainment`),
    ]);
    setSession(s); setPrevSession(p); setWig(w); setRollup(r); setAttainment(a);
    if (w) api.get(`/api/wigs/${team.id}/metrics?months=1`).then(setMetrics).catch(() => setMetrics([]));
    else setMetrics([]);
    api.get('/api/commitments/history?weeks=13').then(setHistory).catch(() => setHistory(null));
    api.get(`/api/analytics/user/${me.id}/history?weeks=12`).then(setUserTrend).catch(() => setUserTrend([]));
  }, [team, wk, pwk, me.id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!team || !isManager) return;
    api.get(`/api/analytics/team/${team.id}/history?weeks=13`).then(setTeamHistory).catch(() => setTeamHistory(null));
    api.get('/api/analytics/my-reports/pending-commitments').then(setReportsPending).catch(() => setReportsPending([]));
  }, [team, isManager]);

  if (!me || !team) return <EmptyState title="No team assigned yet" body="Ask someone in WIG Administration to add you to a team." />;
  if (!session) return <div style={{ color: COLORS.textMuted }}>Loading…</div>;

  const myCommitmentsThisWeek = session.commitments.filter((c) => c.user_id === me.id);
  const myPrevCommitments = prevSession ? prevSession.commitments.filter((c) => c.user_id === me.id && c.commitment_made === 'yes') : [];
  const undecidedPrev = myPrevCommitments.filter((c) => c.commitment_met === 'pending');
  const metricsDue = isManager && wig && !metrics.some((m) => m.measurement_date.slice(0, 7) === mo && m.lag_actual !== null);

  const reminders = [];
  if (myCommitmentsThisWeek.length === 0) {
    reminders.push({ key: 'commit', title: "Log this week's commitment", onAction: () => onNavigate('myweek') });
  }
  if (undecidedPrev.length > 0) {
    reminders.push({
      key: 'closeout',
      title: `Close out last week's commitment${undecidedPrev.length > 1 ? 's' : ''} (${undecidedPrev.length})`,
      onAction: () => onNavigate('myweek'),
    });
  }
  if (metricsDue) {
    reminders.push({ key: 'metrics', title: `This month's WIG numbers (${mo}) haven't been logged`, onAction: () => onNavigate('team') });
  }

  const userTrendData = (userTrend || []).map((p) => ({ week: p.week.slice(5), pct: p.pct != null ? Math.round(p.pct * 100) : null }));
  const teamTrendData = (teamHistory || []).map((h) => ({ week: h.week.slice(5), score: h.score }));

  return (
    <div style={{ maxWidth: 960 }}>
      <PageHeader eyebrow={team.display_name || team.name} title={`Welcome back, ${me.first_name}`} sub={`Week of ${wk}`} />

      <Card style={{ marginBottom: 18 }}>
        <Label>To-do</Label>
        {reminders.length === 0 ? (
          <div style={{ fontSize: 13, color: COLORS.textMuted, padding: '8px 0' }}>You're all caught up. 🎉</div>
        ) : (
          reminders.map((r) => (
            <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: `1px solid ${COLORS.line}` }}>
              <BellRing size={16} color={COLORS.gold} />
              <div style={{ flex: 1, fontSize: 13.5 }}>{r.title}</div>
              <Btn variant="ghost" onClick={r.onAction} style={{ padding: '6px 10px' }}>Go <ChevronRight size={13} /></Btn>
            </div>
          ))
        )}
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px,1fr))', gap: 14, marginBottom: 18 }}>
        <Card>
          <Label>My commitments <span style={{ textTransform: 'none', fontWeight: 400 }}>— T13w</span></Label>
          {history ? (
            <>
              <div style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 24, fontWeight: 600,
                color: history.stats.pct == null ? COLORS.textMuted : history.stats.pct >= 0.9 ? COLORS.green : history.stats.pct >= 0.8 ? COLORS.gold : COLORS.red }}>
                {history.stats.pct != null ? `${Math.round(history.stats.pct * 100)}%` : '–'}
              </div>
              <div style={{ fontSize: 11.5, color: COLORS.textMuted, marginBottom: 10 }}>{history.stats.met}/{history.stats.made} met (T13w)</div>
              <div style={{ height: 80 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={userTrendData}>
                    <XAxis dataKey="week" stroke={COLORS.textMuted} fontSize={9} interval={Math.ceil(userTrendData.length / 6)} />
                    <YAxis domain={[0, 100]} hide />
                    <Tooltip contentStyle={{ background: COLORS.panelAlt, border: `1px solid ${COLORS.line}`, borderRadius: 8 }} formatter={(v) => (v == null ? '–' : `${v}%`)} />
                    <Bar dataKey="pct" fill={COLORS.gold} radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
          ) : <div style={{ color: COLORS.textMuted, fontSize: 12.5 }}>Loading…</div>}
        </Card>

        <Card style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Gauge score={rollup?.score} />
          <div>
            <Label>{team.display_name || team.name}</Label>
            <Pill color={rollup?.color === 'green' ? COLORS.green : rollup?.color === 'yellow' ? COLORS.gold : COLORS.red}>{rollup?.label || 'No data'}</Pill>
            <div style={{ fontSize: 11.5, color: COLORS.textMuted, marginTop: 8 }}>
              Commit T4w: {attainment?.commit?.[4] != null ? `${Math.round(attainment.commit[4] * 100)}%` : '–'} · Cadence T4w: {attainment?.session?.[4] != null ? `${Math.round(attainment.session[4] * 100)}%` : '–'}
            </div>
          </div>
        </Card>
      </div>

      {isManager && teamHistory && teamHistory.length > 0 && (
        <Card style={{ marginBottom: 18 }}>
          <Label>{team.display_name || team.name} — health score history <span style={{ textTransform: 'none', fontWeight: 400 }}>trailing {teamHistory.length}w</span></Label>
          <div style={{ height: 140 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={teamTrendData}>
                <CartesianGrid stroke={COLORS.line} strokeDasharray="3 3" />
                <XAxis dataKey="week" stroke={COLORS.textMuted} fontSize={10} interval={Math.ceil(teamTrendData.length / 8)} />
                <YAxis stroke={COLORS.textMuted} fontSize={11} domain={[0, 100]} />
                <Tooltip contentStyle={{ background: COLORS.panelAlt, border: `1px solid ${COLORS.line}`, borderRadius: 8 }} />
                <ReferenceLine y={90} stroke={COLORS.green} strokeDasharray="4 4" />
                <ReferenceLine y={70} stroke={COLORS.gold} strokeDasharray="4 4" />
                <Bar dataKey="score" fill={COLORS.green} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {isManager && (
        <Card>
          <Label>Your reports <span style={{ textTransform: 'none', fontWeight: 400 }}>— haven't committed this week</span></Label>
          {reportsPending === null ? (
            <div style={{ color: COLORS.textMuted, fontSize: 12.5 }}>Loading…</div>
          ) : reportsPending.length === 0 ? (
            <div style={{ fontSize: 13, color: COLORS.textMuted, padding: '8px 0' }}>Everyone's logged this week's commitment. 🎉</div>
          ) : (
            reportsPending.map((t) => (
              <div key={t.teamId} style={{ padding: '9px 0', borderBottom: `1px solid ${COLORS.line}` }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{t.teamName}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                  {t.members.map((m) => <Pill key={m.userId} color={COLORS.textMuted}>{m.name}</Pill>)}
                </div>
              </div>
            ))
          )}
        </Card>
      )}
    </div>
  );
}

/* ---------- My Week ---------- */
function MyWeek({ me, team }) {
  const wk = isoWeekMonday();
  const pwk = prevWeekMonday(wk);
  const [session, setSession] = useState(null);
  const [prevSession, setPrevSession] = useState(null);
  const [draft, setDraft] = useState('');
  const [notesDraft, setNotesDraft] = useState('');
  const [closeNotes, setCloseNotes] = useState({});
  const [wig, setWig] = useState(null);
  const [downlineWigs, setDownlineWigs] = useState(null);
  const [selectedWigId, setSelectedWigId] = useState('');
  const [history, setHistory] = useState(null);
  // Anyone manager rank and above may span several downline teams (via the
  // manager_id reporting chain), so they get the option to tag their
  // commitment to a specific downline WIG — see the "which WIG is this
  // for?" dropdown below.
  const isManager = (ROLE_RANK[me?.role] ?? 0) >= ROLE_RANK.manager;

  const load = useCallback(async () => {
    if (!team) return;
    const [s, p, w] = await Promise.all([
      api.get(`/api/sessions/${team.id}/${wk}`),
      api.get(`/api/sessions/${team.id}/${pwk}`),
      api.get(`/api/wigs/${team.id}`),
    ]);
    setSession(s); setPrevSession(p); setWig(w);
    api.get('/api/commitments/history?weeks=13').then(setHistory).catch(() => setHistory(null));
  }, [team, wk, pwk]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!isManager) return;
    api.get('/api/wigs/mine-and-downline').then(setDownlineWigs).catch(() => setDownlineWigs([]));
  }, [isManager]);

  if (!me || !team) return <EmptyState title="No team assigned yet" body="Ask an admin to add you to a team in WIG Administration." />;
  if (!session) return <div style={{ color: COLORS.textMuted }}>Loading…</div>;

  const myCommitmentsThisWeek = session.commitments.filter((c) => c.user_id === me.id);
  const myPrevCommitments = prevSession ? prevSession.commitments.filter((c) => c.user_id === me.id && c.commitment_made === 'yes') : [];
  const undecidedPrev = myPrevCommitments.filter((c) => c.commitment_met === 'pending');

  const addCommitment = async (made) => {
    if (made === 'yes' && !draft.trim()) return;
    await api.post('/api/commitments', { teamId: team.id, weekStart: wk, text: draft.trim(), made, notes: notesDraft.trim(), wigId: selectedWigId || undefined });
    trackEvent('commitment_logged', { made });
    setDraft(''); setNotesDraft(''); setSelectedWigId('');
    load();
  };
  const setMet = async (commitmentId, met) => {
    await api.patch(`/api/commitments/${commitmentId}`, { met, notes: closeNotes[commitmentId] });
    trackEvent('commitment_closed', { met });
    load();
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <PageHeader eyebrow={team.display_name || team.name} title="My Week" sub={`Week of ${wk} · ${wig ? wig.statement : 'No WIG set for this team yet'}`} />

      {undecidedPrev.length > 0 && (
        <Card style={{ marginBottom: 18, borderColor: COLORS.gold + '55' }}>
          <Label>Close out last week's commitment</Label>
          {undecidedPrev.map((c) => (
            <div key={c.id} style={{ padding: '8px 0', borderTop: `1px solid ${COLORS.line}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, fontSize: 13.5 }}>{c.commitment_text}</div>
                <Btn variant="ghost" onClick={() => setMet(c.id, 'yes')} style={{ padding: '6px 10px', color: COLORS.green, borderColor: COLORS.green + '55' }}><Check size={14} /> Met</Btn>
                <Btn variant="ghost" onClick={() => setMet(c.id, 'no')} style={{ padding: '6px 10px', color: COLORS.red, borderColor: COLORS.red + '55' }}><X size={14} /> Not met</Btn>
              </div>
              <Input placeholder="Notes on how it went (optional)" value={closeNotes[c.id] ?? ''} onChange={(e) => setCloseNotes({ ...closeNotes, [c.id]: e.target.value })} style={{ marginTop: 6 }} />
            </div>
          ))}
        </Card>
      )}

      <Card>
        <Label>This week's commitment</Label>
        {myCommitmentsThisWeek.length === 0 ? (
          <>
            {isManager && (
              <div style={{ marginBottom: 8 }}>
                <Select value={selectedWigId} onChange={(e) => setSelectedWigId(e.target.value)}>
                  <option value="">Which WIG is this for? (optional)</option>
                  {(downlineWigs || []).map((w) => <option key={w.id} value={w.id}>{w.teamDisplayName || w.teamName} — {w.statement}</option>)}
                </Select>
                {downlineWigs && downlineWigs.length === 0 && (
                  <div style={{ fontSize: 11.5, color: COLORS.textMuted, marginTop: 4 }}>No active WIGs found in your reporting chain yet.</div>
                )}
              </div>
            )}
            <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="What will you commit to this week?" style={{ marginBottom: 8 }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <Input value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} placeholder="Notes / context (optional)" onKeyDown={(e) => e.key === 'Enter' && addCommitment('yes')} />
              <Btn onClick={() => addCommitment('yes')}><Plus size={14} /> Commit</Btn>
            </div>
            <div style={{ height: 10 }} />
            <Btn variant="ghost" onClick={() => addCommitment('pto')}><Coffee size={14} /> Mark PTO this week instead</Btn>
          </>
        ) : (
          myCommitmentsThisWeek.map((c) => (
            <div key={c.id} style={{ padding: '8px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, fontSize: 13.5 }}>{c.commitment_made === 'pto' ? 'Marked PTO for this session' : c.commitment_text}</div>
                <Pill color={c.commitment_made === 'pto' ? COLORS.textMuted : COLORS.gold}>{c.commitment_made === 'pto' ? 'PTO' : 'Committed'}</Pill>
              </div>
              {c.wig_statement && <div style={{ fontSize: 12, color: COLORS.gold, marginTop: 3 }}>For: {c.wig_statement}</div>}
              {c.notes && <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 3 }}>{c.notes}</div>}
            </div>
          ))
        )}
      </Card>

      {history && (
        <Card style={{ marginTop: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <Label>Commitment history</Label>
            {history.stats.pct !== null && (
              <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 13, fontWeight: 600,
                color: history.stats.pct >= 0.9 ? COLORS.green : history.stats.pct >= 0.8 ? COLORS.gold : COLORS.red }}>
                {history.stats.met}/{history.stats.made} met ({Math.round(history.stats.pct * 100)}%)
              </span>
            )}
          </div>
          {history.history.length === 0 ? (
            <div style={{ color: COLORS.textMuted, fontSize: 13, padding: '8px 0' }}>No past commitments yet — your history will build up here week over week.</div>
          ) : (
            history.history.map((h) => (
              <div key={h.id} style={{ padding: '10px 0', borderTop: `1px solid ${COLORS.line}` }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ fontSize: 11.5, color: COLORS.textMuted, fontFamily: 'IBM Plex Mono, monospace', width: 82, flexShrink: 0, paddingTop: 2 }}>{h.session_date}</div>
                  <div style={{ flex: 1, fontSize: 13.5 }}>{h.commitment_made === 'pto' ? 'PTO this week' : h.commitment_text}</div>
                  <Pill color={
                    h.commitment_made === 'pto' ? COLORS.textMuted
                      : h.commitment_met === 'yes' ? COLORS.green
                      : h.commitment_met === 'no' ? COLORS.red
                      : COLORS.gold
                  }>
                    {h.commitment_made === 'pto' ? 'PTO' : h.commitment_met === 'yes' ? 'Met' : h.commitment_met === 'no' ? 'Not met' : 'Pending'}
                  </Pill>
                </div>
                {h.notes && <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 4, marginLeft: 92 }}>{h.notes}</div>}
              </div>
            ))
          )}
        </Card>
      )}
    </div>
  );
}

/* ---------- Team Scoreboard ---------- */
function TeamScoreboard({ teams, defaultTeamId, me }) {
  const [teamId, setTeamId] = useState(defaultTeamId || teams[0]?.id || '');
  const [wig, setWig] = useState(null);
  const [attainment, setAttainment] = useState(null);
  const [rollup, setRollup] = useState(null);
  const [session, setSession] = useState(null);
  const [metrics, setMetrics] = useState([]);
  const [individuals, setIndividuals] = useState(null);
  const [history, setHistory] = useState(null);
  const [pending, setPending] = useState(null);
  const [expandedUserId, setExpandedUserId] = useState(null);
  const wk = isoWeekMonday();
  const mo = wk.slice(0, 7);
  const isManager = (ROLE_RANK[me?.role] ?? 0) >= ROLE_RANK.manager;

  useEffect(() => { if (!teamId && teams[0]) setTeamId(teams[0].id); }, [teams]);

  const load = useCallback(async () => {
    if (!teamId) return;
    const [w, a, r, s, m] = await Promise.all([
      api.get(`/api/wigs/${teamId}`),
      api.get(`/api/analytics/team/${teamId}/attainment`),
      api.get(`/api/analytics/rollup/${teamId}`),
      api.get(`/api/sessions/${teamId}/${wk}`),
      api.get(`/api/wigs/${teamId}/metrics?months=8`),
    ]);
    setWig(w); setAttainment(a); setRollup(r); setSession(s); setMetrics(m);
    api.get(`/api/analytics/team/${teamId}/individuals`).then(setIndividuals).catch(() => setIndividuals(null));
    api.get(`/api/analytics/team/${teamId}/history?weeks=26`).then(setHistory).catch(() => setHistory(null));
    api.get(`/api/analytics/team/${teamId}/pending-commitments`).then(setPending).catch(() => setPending(null));
  }, [teamId, wk]);

  useEffect(() => { load(); }, [load]);

  if (teams.length === 0) return <EmptyState title="No teams yet" body="Create your first team in WIG Administration to start tracking a WIG." />;

  const metricsDue = wig && !metrics.some((m) => m.measurement_date.slice(0, 7) === mo && m.lag_actual !== null);
  const historyTrend = (history || []).map((h) => ({ week: h.week.slice(5), score: h.score }));

  const toggleSession = async () => {
    const held = !session?.held;
    await api.put(`/api/sessions/${teamId}/${wk}/held`, { held });
    trackEvent('session_toggled', { held });
    load();
  };
  const saveMetric = async (field, val) => {
    const body = { lagActual: metrics.at(-1)?.lag_actual, lead1Actual: metrics.at(-1)?.lead1_actual, [field]: val };
    await api.put(`/api/wigs/${teamId}/metrics/${mo}`, body);
    trackEvent('wig_metric_saved', { field });
    load();
  };

  const committed = session ? session.commitments.filter((c) => c.commitment_made === 'yes').length : 0;
  const pto = session ? session.commitments.filter((c) => c.commitment_made === 'pto').length : 0;
  const lagTrend = metrics.map((m) => ({ month: m.measurement_date.slice(0, 7), actual: m.lag_actual !== null ? Number(m.lag_actual) : null }));

  return (
    <div style={{ maxWidth: 920 }}>
      <PageHeader eyebrow="Team" title="Scoreboard" sub={wig ? wig.statement : 'No WIG defined'} />
      <div style={{ marginBottom: 18 }}>
        <Select value={teamId} onChange={(e) => setTeamId(Number(e.target.value))} style={{ maxWidth: 280 }}>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.display_name || t.name}</option>)}
        </Select>
      </div>

      {!wig ? (
        <EmptyState title="No WIG set for this team" body="Define a Wildly Important Goal for this team in WIG Administration." />
      ) : (
        <>
          {isManager && metricsDue && (
            <Card style={{ marginBottom: 18, borderColor: COLORS.gold + '55', display: 'flex', alignItems: 'center', gap: 10 }}>
              <BellRing size={16} color={COLORS.gold} />
              <div style={{ fontSize: 13.5 }}>This month's WIG metrics ({mo}) haven't been logged yet — enter them below.</div>
            </Card>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px,1fr))', gap: 14, marginBottom: 18 }}>
            <Card style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <Gauge score={rollup?.score} />
              <div><Label>Overall health</Label><Pill color={rollup?.color === 'green' ? COLORS.green : rollup?.color === 'yellow' ? COLORS.gold : COLORS.red}>{rollup?.label || 'No data'}</Pill></div>
            </Card>
            <Card>
              <Label>Commitment attainment (T4w)</Label>
              <div style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 24, fontWeight: 600, color: attainment?.commitBand?.color === 'green' ? COLORS.green : attainment?.commitBand?.color === 'yellow' ? COLORS.gold : COLORS.red }}>
                {attainment?.commit?.[4] != null ? `${Math.round(attainment.commit[4] * 100)}%` : '–'}
              </div>
              <div style={{ fontSize: 11, color: COLORS.textMuted }}>T13w: {attainment?.commit?.[13] != null ? `${Math.round(attainment.commit[13] * 100)}%` : '–'}</div>
            </Card>
            <Card>
              <Label>Cadence attainment (T4w)</Label>
              <div style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 24, fontWeight: 600, color: attainment?.sessionBand?.color === 'green' ? COLORS.green : attainment?.sessionBand?.color === 'yellow' ? COLORS.gold : COLORS.red }}>
                {attainment?.session?.[4] != null ? `${Math.round(attainment.session[4] * 100)}%` : '–'}
              </div>
              <div style={{ fontSize: 11, color: COLORS.textMuted }}>T13w: {attainment?.session?.[13] != null ? `${Math.round(attainment.session[13] * 100)}%` : '–'}</div>
            </Card>
          </div>

          <Card style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <div>
                <Label>This week's cadence session</Label>
                <div style={{ fontSize: 12.5, color: COLORS.textMuted }}>{committed} committed{pto ? `, ${pto} PTO` : ''}</div>
              </div>
              <Btn variant={session?.held ? 'primary' : 'ghost'} onClick={toggleSession}>
                {session?.held ? <Check size={14} /> : <Calendar size={14} />} {session?.held ? 'Session held' : 'Mark session held'}
              </Btn>
            </div>
            {isManager && pending && pending.length > 0 && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${COLORS.line}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: COLORS.gold, marginBottom: 6 }}>
                  <BellRing size={13} /> Haven't committed yet this week
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {pending.map((p) => <Pill key={p.userId} color={COLORS.textMuted}>{p.name}</Pill>)}
                </div>
              </div>
            )}
          </Card>

          <Card style={{ marginBottom: 18 }}>
            <Label>WIG metrics — {mo} (monthly)</Label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))', gap: 12, marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 4 }}>{wig.lagMeasure?.label} (target {wig.lagMeasure?.target_value} {wig.lagMeasure?.unit})</div>
                <Input type="number" defaultValue={metrics.at(-1)?.lag_actual ?? ''} onBlur={(e) => saveMetric('lagActual', e.target.value)} placeholder="Actual" />
              </div>
              {wig.lead1 && (
                <div>
                  <div style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 4 }}>{wig.lead1.label} (target {wig.lead1.target_value} {wig.lead1.unit})</div>
                  <Input type="number" defaultValue={metrics.at(-1)?.lead1_actual ?? ''} onBlur={(e) => saveMetric('lead1Actual', e.target.value)} placeholder="Actual" />
                </div>
              )}
            </div>
            <div style={{ height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={lagTrend}>
                  <CartesianGrid stroke={COLORS.line} strokeDasharray="3 3" />
                  <XAxis dataKey="month" stroke={COLORS.textMuted} fontSize={11} />
                  <YAxis stroke={COLORS.textMuted} fontSize={11} />
                  <Tooltip contentStyle={{ background: COLORS.panelAlt, border: `1px solid ${COLORS.line}`, borderRadius: 8 }} />
                  {wig.lagMeasure?.target_value && <ReferenceLine y={Number(wig.lagMeasure.target_value)} stroke={COLORS.gold} strokeDasharray="4 4" />}
                  <Line type="monotone" dataKey="actual" stroke={COLORS.green} strokeWidth={2.5} dot={{ r: 3 }} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>

          {individuals && individuals.length > 0 && (
            <Card>
              <Label>Individual attainment <span style={{ textTransform: 'none', fontWeight: 400 }}>— click a name for their history</span></Label>
              <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 1fr', gap: 8, fontSize: 11, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, padding: '0 0 8px', borderBottom: `1px solid ${COLORS.line}` }}>
                <div>Name</div><div>T4w</div><div>T13w</div><div>Made / Met (T4w)</div>
              </div>
              {individuals.map((m) => (
                <div key={m.userId}>
                  <div onClick={() => setExpandedUserId(expandedUserId === m.userId ? null : m.userId)}
                    style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 1fr', gap: 8, alignItems: 'center', padding: '9px 0', borderBottom: `1px solid ${COLORS.line}`, fontSize: 13, cursor: 'pointer' }}>
                    <div>{m.name}</div>
                    <div><Pill color={m.band.color === 'green' ? COLORS.green : m.band.color === 'yellow' ? COLORS.gold : COLORS.red}>{m.pct4 != null ? `${Math.round(m.pct4 * 100)}%` : '–'}</Pill></div>
                    <div style={{ color: COLORS.textMuted }}>{m.pct13 != null ? `${Math.round(m.pct13 * 100)}%` : '–'}</div>
                    <div style={{ color: COLORS.textMuted, fontFamily: 'IBM Plex Mono, monospace' }}>{m.met4}/{m.made4}</div>
                  </div>
                  {expandedUserId === m.userId && <UserHistoryPanel userId={m.userId} />}
                </div>
              ))}
            </Card>
          )}

          {history && history.length > 0 && (
            <Card style={{ marginTop: 18 }}>
              <Label>Team health score history — trailing {history.length}w, 4w rolling window per point</Label>
              <div style={{ height: 180 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={historyTrend}>
                    <CartesianGrid stroke={COLORS.line} strokeDasharray="3 3" />
                    <XAxis dataKey="week" stroke={COLORS.textMuted} fontSize={10} interval={Math.ceil(historyTrend.length / 10)} />
                    <YAxis stroke={COLORS.textMuted} fontSize={11} domain={[0, 100]} />
                    <Tooltip contentStyle={{ background: COLORS.panelAlt, border: `1px solid ${COLORS.line}`, borderRadius: 8 }} />
                    <ReferenceLine y={90} stroke={COLORS.green} strokeDasharray="4 4" />
                    <ReferenceLine y={70} stroke={COLORS.gold} strokeDasharray="4 4" />
                    <Bar dataKey="score" fill={COLORS.green} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
function UserHistoryPanel({ userId, weeks = 16 }) {
  const [points, setPoints] = useState(null);
  useEffect(() => { api.get(`/api/analytics/user/${userId}/history?weeks=${weeks}`).then(setPoints).catch(() => setPoints([])); }, [userId, weeks]);
  const trend = (points || []).map((p) => ({ week: p.week.slice(5), pct: p.pct != null ? Math.round(p.pct * 100) : null }));
  return (
    <div style={{ padding: '10px 0 16px', borderBottom: `1px solid ${COLORS.line}` }}>
      {points === null ? (
        <div style={{ fontSize: 12, color: COLORS.textMuted }}>Loading history…</div>
      ) : (
        <div style={{ height: 100 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={trend}>
              <XAxis dataKey="week" stroke={COLORS.textMuted} fontSize={9} interval={Math.ceil(trend.length / 8)} />
              <YAxis domain={[0, 100]} hide />
              <Tooltip contentStyle={{ background: COLORS.panelAlt, border: `1px solid ${COLORS.line}`, borderRadius: 8 }} formatter={(v) => (v == null ? '–' : `${v}%`)} />
              <Bar dataKey="pct" fill={COLORS.gold} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

/* ---------- Leadership ---------- */
const WIDGET_CATALOG = [
  { id: 'alerts', title: 'Below Red Threshold (T4w)', Component: AlertsWidget },
  { id: 'pendingCommitments', title: "Haven't Committed This Week", Component: PendingCommitmentsWidget },
  { id: 'metricsDue', title: 'WIG Metrics Not Yet Logged', Component: MetricsDueWidget },
  { id: 'wigStatus', title: 'WIG Status Across the Org', Component: WigStatusWidget },
  { id: 'leaderboard', title: 'Individual Attainment Leaderboard (T4w)', Component: LeaderboardWidget },
  { id: 'heatmap', title: 'Org Heatmap (8w)', Component: HeatmapWidget },
  { id: 'rollup', title: 'Division / Team Rollup', Component: RollupWidget },
  { id: 'auditRecent', title: 'Recent Activity', Component: AuditWidget },
];
const DEFAULT_LAYOUT = WIDGET_CATALOG.map((w) => w.id);
const FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly'];

function Leadership({ teams, me }) {
  const [layout, setLayout] = useState(DEFAULT_LAYOUT);
  const [editingLayout, setEditingLayout] = useState(false);
  const canView = me.role !== 'ic';

  useEffect(() => {
    if (!canView) return;
    api.get('/api/preferences/dashboard_widgets').then((v) => { if (Array.isArray(v) && v.length) setLayout(v); }).catch(() => {});
  }, [canView]);

  const saveLayout = (next) => { setLayout(next); trackEvent('dashboard_layout_changed'); api.put('/api/preferences/dashboard_widgets', next).catch(() => {}); };
  const toggleWidget = (id) => saveLayout(layout.includes(id) ? layout.filter((w) => w !== id) : [...layout, id]);
  const moveWidget = (id, dir) => {
    const i = layout.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= layout.length) return;
    const next = [...layout];
    [next[i], next[j]] = [next[j], next[i]];
    saveLayout(next);
  };

  if (!canView) return <EmptyState title="Org Analytics access required" body="This view is available to Manager, Director, VP, SVP, and Exec — ask someone in one of those roles to grant you access in WIG Administration." />;

  return (
    <div style={{ maxWidth: 960 }}>
      <PageHeader eyebrow="Organization" title="Org Analytics" sub="Custom dashboards, org-wide drill-down, and scheduled rollups for senior leadership" />

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
        <Btn variant="ghost" onClick={() => setEditingLayout(!editingLayout)}><Settings size={14} /> {editingLayout ? 'Done customizing' : 'Customize dashboard'}</Btn>
      </div>

      {editingLayout && (
        <Card style={{ marginBottom: 18 }}>
          <Label>Widgets — check to show, use arrows to reorder</Label>
          {WIDGET_CATALOG.map((w) => {
            const on = layout.includes(w.id);
            const pos = layout.indexOf(w.id);
            return (
              <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: `1px solid ${COLORS.line}` }}>
                <input type="checkbox" checked={on} onChange={() => toggleWidget(w.id)} />
                <div style={{ flex: 1, fontSize: 13.5, color: on ? COLORS.textHi : COLORS.textMuted }}>{w.title}</div>
                {on && (
                  <div style={{ display: 'flex', gap: 4 }}>
                    <Btn variant="ghost" onClick={() => moveWidget(w.id, -1)} disabled={pos === 0} style={{ padding: '4px 8px' }}>↑</Btn>
                    <Btn variant="ghost" onClick={() => moveWidget(w.id, 1)} disabled={pos === layout.length - 1} style={{ padding: '4px 8px' }}>↓</Btn>
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      )}

      <ReportSubscriptions />

      {layout.filter((id) => WIDGET_CATALOG.some((w) => w.id === id)).map((id) => {
        const w = WIDGET_CATALOG.find((x) => x.id === id);
        const W = w.Component;
        return <W key={id} title={w.title} teams={teams} />;
      })}
    </div>
  );
}

function WidgetCard({ title, children, borderColor }) {
  return (
    <Card style={{ marginBottom: 18, ...(borderColor ? { borderColor } : {}) }}>
      <Label>{title}</Label>
      {children}
    </Card>
  );
}
function AlertsWidget({ title }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get('/api/analytics/alerts').then(setRows).catch(() => setRows([])); }, []);
  if (rows === null) return null;
  return (
    <WidgetCard title={title} borderColor={rows.length ? COLORS.red + '55' : undefined}>
      {rows.length === 0 ? <div style={{ fontSize: 12.5, color: COLORS.textMuted }}>No teams below threshold. 🎉</div> : rows.map((a, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0' }}>
          <AlertTriangle size={15} color={COLORS.red} />
          <div style={{ flex: 1, fontSize: 13.5 }}>{a.teamName} — {a.metric}</div>
          <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 12.5, color: COLORS.red }}>{Math.round(a.value * 100)}%</span>
        </div>
      ))}
    </WidgetCard>
  );
}
function PendingCommitmentsWidget({ title }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get('/api/analytics/org/pending-commitments').then(setRows).catch(() => setRows([])); }, []);
  if (rows === null) return null;
  return (
    <WidgetCard title={title} borderColor={rows.length ? COLORS.gold + '55' : undefined}>
      {rows.length === 0 ? <div style={{ fontSize: 12.5, color: COLORS.textMuted }}>Everyone's logged this week's commitment. 🎉</div> : rows.map((t) => (
        <div key={t.teamId} style={{ padding: '7px 0', borderBottom: `1px solid ${COLORS.line}` }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{t.teamName}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            {t.members.map((m) => <Pill key={m.id} color={COLORS.textMuted}>{m.first_name} {m.last_name}</Pill>)}
          </div>
        </div>
      ))}
    </WidgetCard>
  );
}
function MetricsDueWidget({ title }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get('/api/analytics/metrics-due').then(setRows).catch(() => setRows([])); }, []);
  if (rows === null) return null;
  return (
    <WidgetCard title={title} borderColor={rows.length ? COLORS.gold + '55' : undefined}>
      {rows.length === 0 ? <div style={{ fontSize: 12.5, color: COLORS.textMuted }}>Every active WIG is up to date this month. 🎉</div> : rows.map((m) => (
        <div key={m.wigId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0' }}>
          <BellRing size={15} color={COLORS.gold} />
          <div style={{ flex: 1, fontSize: 13.5 }}>{m.teamName} — {m.statement}</div>
        </div>
      ))}
    </WidgetCard>
  );
}
function WigStatusWidget({ title }) {
  const [data, setData] = useState(null);
  useEffect(() => { api.get('/api/analytics/org/wig-status-summary').then(setData).catch(() => setData({ counts: [], recentlyCompleted: [] })); }, []);
  if (data === null) return null;
  const countOf = (status) => data.counts.find((c) => c.status === status)?.n || 0;
  return (
    <WidgetCard title={title}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <Pill color={COLORS.green}>{countOf('active')} active</Pill>
        <Pill color={COLORS.gold}>{countOf('on_hold')} on hold</Pill>
        <Pill color={COLORS.textMuted}>{countOf('completed')} completed</Pill>
      </div>
      {data.recentlyCompleted.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>Recently completed</div>
          {data.recentlyCompleted.map((w) => (
            <div key={w.id} style={{ padding: '6px 0', borderBottom: `1px solid ${COLORS.line}`, fontSize: 13 }}>
              {w.teamName} — {w.statement} <span style={{ color: COLORS.textMuted, fontSize: 11.5 }}>({w.effective_end})</span>
            </div>
          ))}
        </>
      )}
    </WidgetCard>
  );
}
function LeaderboardWidget({ title }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get('/api/analytics/org/individuals?limit=15').then(setRows).catch(() => setRows([])); }, []);
  if (rows === null) return null;
  return (
    <WidgetCard title={title}>
      {rows.map((r, i) => (
        <div key={r.userId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: `1px solid ${COLORS.line}`, fontSize: 13 }}>
          <div style={{ width: 20, color: COLORS.textMuted, fontFamily: 'IBM Plex Mono, monospace' }}>{i + 1}</div>
          <div style={{ flex: 1 }}>{r.name} <span style={{ color: COLORS.textMuted, fontSize: 11.5 }}>· {r.team}</span></div>
          <Pill color={r.pct == null ? COLORS.textMuted : r.pct >= 0.9 ? COLORS.green : r.pct >= 0.7 ? COLORS.gold : COLORS.red}>{r.pct != null ? `${Math.round(r.pct * 100)}%` : '–'}</Pill>
        </div>
      ))}
    </WidgetCard>
  );
}
function HeatmapWidget({ title }) {
  const [data, setData] = useState(null);
  useEffect(() => { api.get('/api/analytics/org/heatmap?weeks=8').then(setData).catch(() => setData(null)); }, []);
  if (!data) return null;
  const cellColor = (score) => score == null ? COLORS.line : score >= 90 ? COLORS.green : score >= 70 ? COLORS.gold : COLORS.red;
  return (
    <WidgetCard title={title}>
      <div style={{ overflowX: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: `140px repeat(${data.weeks.length}, 28px)`, gap: 4, alignItems: 'center' }}>
          <div />
          {data.weeks.map((w) => <div key={w} style={{ fontSize: 9, color: COLORS.textMuted, textAlign: 'center' }}>{w.slice(5)}</div>)}
          {data.teams.map((t) => (
            <React.Fragment key={t.teamId}>
              <div style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.teamName}</div>
              {t.cells.map((c) => <div key={c.week} title={`${t.teamName} · ${c.week}: ${c.score ?? 'no data'}`} style={{ width: 24, height: 24, borderRadius: 4, background: cellColor(c.score) }} />)}
            </React.Fragment>
          ))}
        </div>
      </div>
    </WidgetCard>
  );
}
function RollupWidget({ title, teams }) {
  const topTeams = teams.filter((t) => !t.parent_id);
  return (
    <div style={{ marginBottom: 18 }}>
      <Label>{title}</Label>
      {topTeams.length === 0 ? <EmptyState title="No teams yet" body="Create teams in WIG Administration to see the org rollup here." /> :
        topTeams.map((t) => <TeamRollupRow key={t.id} team={t} teams={teams} depth={0} />)}
    </div>
  );
}
function AuditWidget({ title }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get('/api/audit?limit=10').then(setRows).catch(() => setRows([])); }, []);
  if (rows === null) return null;
  return (
    <WidgetCard title={title}>
      {rows.length === 0 ? <div style={{ fontSize: 12.5, color: COLORS.textMuted }}>No activity yet.</div> : rows.map((r) => (
        <div key={r.id} style={{ padding: '6px 0', borderBottom: `1px solid ${COLORS.line}`, fontSize: 12 }}>
          <strong>{r.action}</strong> · {r.entity_type}{r.entity_id ? ` #${r.entity_id}` : ''}
          <span style={{ color: COLORS.textMuted }}> — {r.first_name ? `${r.first_name} ${r.last_name}` : 'system'} · {r.created_at}</span>
        </div>
      ))}
    </WidgetCard>
  );
}
function ReportSubscriptions() {
  const [subs, setSubs] = useState([]);
  const [frequency, setFrequency] = useState('weekly');
  const [widgets, setWidgets] = useState(DEFAULT_LAYOUT);
  const [channelEmail, setChannelEmail] = useState(true);
  const [channelTeams, setChannelTeams] = useState(false);

  const load = useCallback(() => api.get('/api/subscriptions').then(setSubs).catch(() => setSubs([])), []);
  useEffect(() => { load(); }, [load]);

  const toggleWidget = (id) => setWidgets(widgets.includes(id) ? widgets.filter((w) => w !== id) : [...widgets, id]);
  const create = async () => {
    if (widgets.length === 0) return;
    await api.post('/api/subscriptions', { frequency, widgets, channelEmail, channelTeams });
    trackEvent('subscription_created', { frequency });
    load();
  };
  const toggleActive = async (s) => { await api.patch(`/api/subscriptions/${s.id}`, { active: !s.active }); trackEvent('subscription_toggled', { active: !s.active }); load(); };
  const remove = async (id) => { await api.del(`/api/subscriptions/${id}`); trackEvent('subscription_deleted'); load(); };

  return (
    <Card style={{ marginBottom: 18 }}>
      <Label>Emailed / Teams rollups</Label>
      <div style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 12 }}>
        Get the widgets you care about sent on a schedule. Emails are logged by the server until a real provider is configured — see server/src/lib/notify.js.
      </div>
      {subs.map((s) => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: `1px solid ${COLORS.line}`, fontSize: 13 }}>
          <Pill color={s.active ? COLORS.green : COLORS.textMuted}>{s.frequency}</Pill>
          <div style={{ flex: 1, color: COLORS.textMuted, fontSize: 12 }}>
            {(Array.isArray(s.widgets) ? s.widgets : JSON.parse(s.widgets)).length} widgets · {s.channel_email ? 'email' : ''}{s.channel_email && s.channel_teams ? ' + ' : ''}{s.channel_teams ? 'Teams' : ''}
          </div>
          <Btn variant="ghost" onClick={() => toggleActive(s)} style={{ padding: '5px 9px' }}>{s.active ? 'Pause' : 'Resume'}</Btn>
          <Trash2 size={14} color={COLORS.textMuted} style={{ cursor: 'pointer' }} onClick={() => remove(s.id)} />
        </div>
      ))}
      <div style={{ marginTop: subs.length ? 14 : 0 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <Select value={frequency} onChange={(e) => setFrequency(e.target.value)} style={{ maxWidth: 160 }}>
            {FREQUENCIES.map((f) => <option key={f} value={f}>{f[0].toUpperCase() + f.slice(1)}</option>)}
          </Select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={channelEmail} onChange={(e) => setChannelEmail(e.target.checked)} /> Email
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={channelTeams} onChange={(e) => setChannelTeams(e.target.checked)} /> Teams
          </label>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
          {WIDGET_CATALOG.map((w) => (
            <label key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
              <input type="checkbox" checked={widgets.includes(w.id)} onChange={() => toggleWidget(w.id)} /> {w.title}
            </label>
          ))}
        </div>
        <Btn onClick={create} disabled={widgets.length === 0}><Plus size={14} /> Add subscription</Btn>
      </div>
    </Card>
  );
}
function TeamRollupRow({ team, teams, depth }) {
  const [open, setOpen] = useState(true);
  const [rollup, setRollup] = useState(null);
  const children = teams.filter((t) => t.parent_id === team.id);
  useEffect(() => { api.get(`/api/analytics/rollup/${team.id}`).then(setRollup).catch(() => {}); }, [team.id]);

  return (
    <div style={{ marginLeft: depth * 20, marginBottom: 10 }}>
      <Card style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px' }}>
        {children.length > 0 ? <div onClick={() => setOpen(!open)} style={{ cursor: 'pointer', color: COLORS.textMuted }}>{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</div> : <div style={{ width: 16 }} />}
        <Gauge score={rollup?.score} size={44} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{team.display_name || team.name}</div>
          <div style={{ fontSize: 12, color: COLORS.textMuted }}>
            {children.length ? `${children.length} team${children.length > 1 ? 's' : ''}` : 'Leaf team'}
            {rollup?.min != null && rollup.min !== rollup.max ? ` · spread ${rollup.min}–${rollup.max}` : ''}
          </div>
        </div>
        <Pill color={rollup?.color === 'green' ? COLORS.green : rollup?.color === 'yellow' ? COLORS.gold : COLORS.red}>{rollup?.label || 'No data'}</Pill>
      </Card>
      {open && children.map((c) => <TeamRollupRow key={c.id} team={c} teams={teams} depth={depth + 1} />)}
    </div>
  );
}

/* ---------- Setup ---------- */
function Setup({ teams, onTeamsChanged, me }) {
  const [section, setSection] = useState('teams');
  if (me.role === 'ic') return <EmptyState title="Admin access required" body="This section is available to Manager, Director, VP, SVP, and Exec — ask someone in one of those roles to manage teams, WIGs, and people on your behalf." />;
  return (
    <div style={{ maxWidth: 760 }}>
      <PageHeader eyebrow="Configuration" title="WIG Administration" sub="Manage divisions/teams, people, WIGs, and health thresholds" />
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {[['teams', 'Teams'], ['wigs', 'WIGs'], ['users', 'People'], ['config', 'Thresholds'], ['audit', 'Audit Log']].map(([id, label]) => (
          <Btn key={id} variant={section === id ? 'primary' : 'ghost'} onClick={() => setSection(id)}>{label}</Btn>
        ))}
      </div>
      {section === 'teams' && <TeamsSetup teams={teams} onChanged={onTeamsChanged} />}
      {section === 'wigs' && <WigsSetup teams={teams} />}
      {section === 'users' && <UsersSetup teams={teams} onChanged={onTeamsChanged} />}
      {section === 'config' && <ConfigSetup />}
      {section === 'audit' && <AuditLogSetup />}
    </div>
  );
}
function AuditLogSetup() {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get('/api/audit?limit=100').then(setRows).catch(() => setRows([])); }, []);
  if (rows === null) return <div style={{ color: COLORS.textMuted }}>Loading…</div>;
  if (rows.length === 0) return <EmptyState title="No activity yet" body="WIG, team, people, and threshold changes will show up here as they happen." />;
  return (
    <Card>
      {rows.map((r) => (
        <div key={r.id} style={{ padding: '9px 0', borderBottom: `1px solid ${COLORS.line}`, fontSize: 12.5 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
            <span><strong>{r.action}</strong> · {r.entity_type}{r.entity_id ? ` #${r.entity_id}` : ''}</span>
            <span style={{ color: COLORS.textMuted, fontFamily: 'IBM Plex Mono, monospace' }}>{r.created_at}</span>
          </div>
          <div style={{ color: COLORS.textMuted, marginTop: 2 }}>
            {r.first_name ? `${r.first_name} ${r.last_name}` : 'system'}
            {r.detail ? ` — ${JSON.stringify(r.detail)}` : ''}
          </div>
        </div>
      ))}
    </Card>
  );
}
function TeamsSetup({ teams, onChanged }) {
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const add = async () => {
    if (!name.trim()) return;
    await api.post('/api/teams', { name: name.trim(), parentId: parentId || null });
    trackEvent('team_created');
    setName(''); setParentId(''); onChanged();
  };
  const remove = async (id) => {
    try { await api.del(`/api/teams/${id}`); trackEvent('team_deleted'); onChanged(); }
    catch (e) { alert(e.message); }
  };
  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <Label>Add a division or team</Label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CDP_CI or CDP_CI_Arch" style={{ flex: 2, minWidth: 160 }} />
          <Select value={parentId} onChange={(e) => setParentId(e.target.value)} style={{ flex: 1, minWidth: 160 }}>
            <option value="">No parent (division-level)</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          <Btn onClick={add}><Plus size={14} /> Add</Btn>
        </div>
      </Card>
      {teams.map((t) => (
        <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: `1px solid ${COLORS.line}` }}>
          <div style={{ flex: 1, fontSize: 13.5 }}>{t.name}{t.parent_id && <span style={{ color: COLORS.textMuted, fontSize: 12 }}> — under {teams.find((p) => p.id === t.parent_id)?.name}</span>}</div>
          <Trash2 size={14} color={COLORS.textMuted} style={{ cursor: 'pointer' }} onClick={() => remove(t.id)} />
        </div>
      ))}
    </div>
  );
}
function blankWig() { return { statement: '', lagMeasure: { name: '', target: '', unit: '' }, lead1: { name: '', target: '', unit: '' }, lead2: { name: '', target: '', unit: '' }, lead3: { name: '', target: '', unit: '' } }; }
function wigStatusColor(status) {
  return status === 'active' ? COLORS.green : status === 'on_hold' ? COLORS.gold : COLORS.textMuted;
}
function WigsSetup({ teams }) {
  const [teamId, setTeamId] = useState(teams[0]?.id || '');
  const [form, setForm] = useState(blankWig());
  const [activeWig, setActiveWig] = useState(null);
  const [history, setHistory] = useState([]);

  const load = useCallback(() => {
    if (!teamId) return;
    api.get(`/api/wigs/${teamId}`).then((w) => {
      setActiveWig(w);
      if (!w) { setForm(blankWig()); return; }
      setForm({
        statement: w.statement,
        lagMeasure: { name: w.lagMeasure?.label || '', target: w.lagMeasure?.target_value || '', unit: w.lagMeasure?.unit || '' },
        lead1: { name: w.lead1?.label || '', target: w.lead1?.target_value || '', unit: w.lead1?.unit || '' },
        lead2: { name: w.lead2?.label || '', target: w.lead2?.target_value || '', unit: w.lead2?.unit || '' },
        lead3: { name: w.lead3?.label || '', target: w.lead3?.target_value || '', unit: w.lead3?.unit || '' },
      });
    });
    api.get(`/api/wigs/${teamId}/history`).then(setHistory).catch(() => setHistory([]));
  }, [teamId]);
  useEffect(() => { load(); }, [load]);

  const save = async () => { await api.put(`/api/wigs/${teamId}`, form); trackEvent('wig_saved'); load(); };
  const setStatus = async (status) => { await api.patch(`/api/wigs/${teamId}/status`, { status }); trackEvent('wig_status_changed', { status }); load(); };
  const reactivate = async (wigId) => { await api.patch(`/api/wigs/${teamId}/history/${wigId}/reactivate`, {}); trackEvent('wig_reactivated'); load(); };

  if (teams.length === 0) return <EmptyState title="Create a team first" body="You need at least one team before defining a WIG." />;

  const measureField = (key, label) => (
    <div style={{ marginBottom: 14 }}>
      <Label>{label}</Label>
      <Input value={form[key]?.name || ''} onChange={(e) => setForm({ ...form, [key]: { ...form[key], name: e.target.value } })} placeholder="Metric name" style={{ marginBottom: 8 }} />
      <div style={{ display: 'flex', gap: 8 }}>
        <Input value={form[key]?.target || ''} onChange={(e) => setForm({ ...form, [key]: { ...form[key], target: e.target.value } })} placeholder="Target" type="number" />
        <Input value={form[key]?.unit || ''} onChange={(e) => setForm({ ...form, [key]: { ...form[key], unit: e.target.value } })} placeholder="Unit" />
      </div>
    </div>
  );
  const otherHistory = history.filter((h) => h.id !== activeWig?.id);

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <Label>Team</Label>
        <Select value={teamId} onChange={(e) => setTeamId(Number(e.target.value))} style={{ marginBottom: 14 }}>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>

        {activeWig && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <Pill color={wigStatusColor(activeWig.status)}>{activeWig.status}</Pill>
            <Btn variant="ghost" onClick={() => setStatus('completed')} style={{ padding: '6px 10px' }}><CheckCircle2 size={14} /> Mark WIG complete</Btn>
            <Btn variant="ghost" onClick={() => setStatus('on_hold')} style={{ padding: '6px 10px' }}><PauseCircle size={14} /> Put on hold</Btn>
          </div>
        )}
        {!activeWig && (
          <div style={{ fontSize: 12.5, color: COLORS.textMuted, marginBottom: 14 }}>
            No active WIG for this team — fill out the form below to start one.
          </div>
        )}

        <Label>WIG statement</Label>
        <Input value={form.statement} onChange={(e) => setForm({ ...form, statement: e.target.value })} placeholder="e.g. Improve T6M Gross Margin from $23M to $26M" style={{ marginBottom: 14 }} />
        {measureField('lagMeasure', 'Lag measure (the goal itself)')}
        {measureField('lead1', 'Lead measure 1 (optional)')}
        {measureField('lead2', 'Lead measure 2 (optional)')}
        {measureField('lead3', 'Lead measure 3 (optional)')}
        <Btn onClick={save}>{activeWig ? 'Save WIG' : 'Start WIG'}</Btn>
      </Card>

      <Card>
        <Label><History size={12} style={{ verticalAlign: -2, marginRight: 4 }} />WIG history for this team</Label>
        {otherHistory.length === 0 ? (
          <div style={{ fontSize: 12.5, color: COLORS.textMuted }}>No past WIGs yet — completed or on-hold WIGs for this team will show up here.</div>
        ) : (
          otherHistory.map((h) => (
            <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: `1px solid ${COLORS.line}` }}>
              <Pill color={wigStatusColor(h.status)}>{h.status}</Pill>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5 }}>{h.statement}</div>
                <div style={{ fontSize: 11.5, color: COLORS.textMuted }}>
                  {h.effective_start || h.created_at?.slice(0, 10)} → {h.effective_end || 'open'}
                  {h.latestReading ? ` · last reading ${h.latestReading.lag_actual} (${h.latestReading.measurement_date})` : ' · no readings logged'}
                </div>
              </div>
              <Btn variant="ghost" onClick={() => reactivate(h.id)} style={{ padding: '6px 10px' }}><RotateCcw size={13} /> Reactivate</Btn>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
function UsersSetup({ teams, onChanged }) {
  const [users, setUsers] = useState([]);
  const [name, setName] = useState('');
  const [teamId, setTeamId] = useState('');
  const [role, setRole] = useState('ic');
  const [csv, setCsv] = useState('');
  const [importMsg, setImportMsg] = useState('');

  const load = useCallback(() => api.get('/api/users').then(setUsers), []);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!name.trim()) return;
    const [firstName, ...rest] = name.trim().split(' ');
    await api.post('/api/users', { firstName, lastName: rest.join(' '), teamId: teamId || null, role });
    trackEvent('user_created', { role });
    setName(''); load();
  };
  const remove = async (id) => { await api.del(`/api/users/${id}`); trackEvent('user_deactivated'); load(); };
  const reassign = async (id, field, val) => { await api.patch(`/api/users/${id}`, { [field]: val }); trackEvent('user_reassigned', { field }); load(); };
  const importCsv = async () => {
    const lines = csv.split('\n').map((l) => l.trim()).filter(Boolean);
    const header = lines[0]?.toLowerCase() || '';
    const startIdx = header.includes('name') ? 1 : 0;
    const rows = lines.slice(startIdx).map((l) => {
      const [fullName, teamName, r] = l.split(',').map((s) => (s || '').trim());
      return { fullName, teamName, role: r };
    });
    const result = await api.post('/api/users/import', { rows });
    trackEvent('roster_imported', { created: result.created, updated: result.updated });
    setImportMsg(`Imported: ${result.created} new, ${result.updated} updated.`);
    setCsv(''); load(); onChanged();
  };

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <Label>Bulk import roster (CSV)</Label>
        <div style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 8 }}>
          Paste rows as <code>Full Name, Team Name, Role</code> (role optional). Unknown team names are created automatically.
        </div>
        <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={5}
          placeholder={'Full Name,Team Name,Role\nJane Smith,CDP_CI_Arch,ic'}
          style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'IBM Plex Mono, monospace', fontSize: 12.5, padding: 10, borderRadius: 7, border: `1px solid ${COLORS.line}`, background: COLORS.ink, color: COLORS.textHi, marginBottom: 8 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Btn onClick={importCsv} disabled={!csv.trim()}>Import roster</Btn>
          {importMsg && <span style={{ fontSize: 12.5, color: COLORS.green }}>{importMsg}</span>}
        </div>
      </Card>
      <Card style={{ marginBottom: 16 }}>
        <Label>Add a person</Label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" style={{ flex: 2, minWidth: 140 }} />
          <Select value={teamId} onChange={(e) => setTeamId(e.target.value)} style={{ flex: 1, minWidth: 140 }}>
            <option value="">No team</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          <Select value={role} onChange={(e) => setRole(e.target.value)} style={{ flex: 1, minWidth: 120 }}>
            <option value="ic">Individual Contributor</option><option value="manager">Manager</option><option value="director">Director</option><option value="vp">VP</option><option value="svp">SVP</option><option value="exec">Exec</option>
          </Select>
          <Btn onClick={add}><Plus size={14} /> Add</Btn>
        </div>
      </Card>
      {users.map((u) => (
        <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 0', borderBottom: `1px solid ${COLORS.line}`, flexWrap: 'wrap' }}>
          <div style={{ flex: 1.4, minWidth: 120, fontSize: 13.5 }}>{u.first_name} {u.last_name}</div>
          <Select value={u.team_id || ''} onChange={(e) => reassign(u.id, 'teamId', e.target.value || null)} style={{ flex: 1, minWidth: 130 }}>
            <option value="">No team</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          <Select value={u.role} onChange={(e) => reassign(u.id, 'role', e.target.value)} style={{ flex: 1, minWidth: 120 }}>
            <option value="ic">Individual Contributor</option><option value="manager">Manager</option><option value="director">Director</option><option value="vp">VP</option><option value="svp">SVP</option><option value="exec">Exec</option>
          </Select>
          <Select value={u.manager_id || ''} onChange={(e) => reassign(u.id, 'managerId', e.target.value || null)} style={{ flex: 1, minWidth: 150 }}>
            <option value="">No manager set</option>
            {users.filter((m) => m.id !== u.id).map((m) => <option key={m.id} value={m.id}>Reports to {m.first_name} {m.last_name}</option>)}
          </Select>
          <Trash2 size={14} color={COLORS.textMuted} style={{ cursor: 'pointer' }} onClick={() => remove(u.id)} />
        </div>
      ))}
    </div>
  );
}
function ConfigSetup() {
  const [form, setForm] = useState(null);
  useEffect(() => { api.get('/api/config').then(setForm); }, []);
  const save = async () => { await api.put('/api/config', form); trackEvent('thresholds_saved'); alert('Saved'); };
  if (!form) return <div style={{ color: COLORS.textMuted }}>Loading…</div>;
  const pct = (v) => Math.round(v * 100);
  const setPct = (key, v) => setForm({ ...form, [key]: Math.max(0, Math.min(100, Number(v))) / 100 });
  return (
    <Card>
      <Label>Individual commitment attainment</Label>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
        <span style={{ fontSize: 12.5, color: COLORS.textMuted, width: 90 }}>Yellow ≥</span>
        <Input type="number" value={pct(form.commit_yellow)} onChange={(e) => setPct('commit_yellow', e.target.value)} style={{ maxWidth: 100 }} />
        <span style={{ fontSize: 12.5, color: COLORS.textMuted, width: 90 }}>Green ≥</span>
        <Input type="number" value={pct(form.commit_green)} onChange={(e) => setPct('commit_green', e.target.value)} style={{ maxWidth: 100 }} />
      </div>
      <Label>Cadence / session attainment</Label>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
        <span style={{ fontSize: 12.5, color: COLORS.textMuted, width: 90 }}>Yellow ≥</span>
        <Input type="number" value={pct(form.session_yellow)} onChange={(e) => setPct('session_yellow', e.target.value)} style={{ maxWidth: 100 }} />
        <span style={{ fontSize: 12.5, color: COLORS.textMuted, width: 90 }}>Green ≥</span>
        <Input type="number" value={pct(form.session_green)} onChange={(e) => setPct('session_green', e.target.value)} style={{ maxWidth: 100 }} />
      </div>
      <Btn onClick={save}>Save thresholds</Btn>
    </Card>
  );
}
