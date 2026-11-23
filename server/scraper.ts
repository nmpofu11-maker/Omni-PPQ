import {
  LeagueInfo,
  MarketOdds,
  MatchStatus,
  PlayEvent,
  ScrapedMatch,
  SportFilter,
  SportType,
  TeamTelemetry,
} from '../src/types/quant';
import { americanToDecimalOdds, clamp } from '../src/engine/mathUtils';
import { inferDataQuality } from '../src/engine/predictionEngine';
import { CORE_LEAGUES, FULL_LEAGUE_CATALOG } from './leaguesCatalog';

const ESPN_HOSTS = [
  'https://site.api.espn.com',
  'https://site.web.api.espn.com',
];

const USER_AGENT = 'OmniPulseQuant/1.0 (+https://localhost:3000)';

// Tracks exact sportPath per match ID for /api/matches/:id summary lookups
const sportPathRegistry = new Map<string, string>();
const matchBaseCache = new Map<string, ScrapedMatch>();

interface CacheEntry<T> {
  expiresAt: number;
  data: T;
}

const scoreboardCache = new Map<string, CacheEntry<ScrapedMatch[]>>();
const summaryCache = new Map<string, CacheEntry<ScrapedMatch>>();
const bbcScoresCache = new Map<string, CacheEntry<BbcMatchScore[]>>();
const dynamicLeaguesCache = new Map<string, LeagueInfo>();

interface BbcMatchScore {
  homeNorm: string;
  awayNorm: string;
  homeScore: number;
  awayScore: number;
  clock?: string;
}

export function registerMatchSportPath(matchId: string, sportPath: string): void {
  if (matchId && sportPath) {
    sportPathRegistry.set(matchId, sportPath);
  }
}

export function getRegisteredSportPath(matchId: string): string | undefined {
  return sportPathRegistry.get(matchId);
}

function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(fc|cf|sc|afc|ac|as|cd|ud|rc|rcd|sd|sv|vfl|vfb|tsg|rb|fk|sk|bk|if|ik|united|city|town|rovers|athletic|albion|wanderers)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

async function fetchJsonWithFallback(pathAndQuery: string, timeoutMs = 8500): Promise<any | null> {
  for (const host of ESPN_HOSTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${host}${pathAndQuery}`, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        return await res.json();
      }
    } catch {
      clearTimeout(timer);
    }
  }
  return null;
}

async function fetchBbcSoccerScores(): Promise<BbcMatchScore[]> {
  const today = new Date().toISOString().slice(0, 10);
  const cached = bbcScoresCache.get(today);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const results: BbcMatchScore[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const url = `https://web-cdn.api.bbci.co.uk/wc-poll-data/container/sport-data-scores-fixtures?selectedEndDate=${today}&selectedStartDate=${today}&todayDate=${today}&urn=urn:bbc:sportsdata:football:tournament-collection:collated`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const json: any = await res.json();
      const eventGroups = json?.eventGroups ?? [];
      for (const grp of eventGroups) {
        const events = grp?.secondaryGroups
          ? grp.secondaryGroups.flatMap((s: any) => s.events ?? [])
          : grp?.events ?? [];
        for (const ev of events) {
          const homeName = ev?.home?.fullName || ev?.home?.shortName;
          const awayName = ev?.away?.fullName || ev?.away?.shortName;
          const hScore = Number(ev?.home?.score);
          const aScore = Number(ev?.away?.score);
          if (homeName && awayName && Number.isFinite(hScore) && Number.isFinite(aScore)) {
            results.push({
              homeNorm: normalizeTeamName(homeName),
              awayNorm: normalizeTeamName(awayName),
              homeScore: hScore,
              awayScore: aScore,
              clock: ev?.statusComment?.value || ev?.periodLabel?.value,
            });
          }
        }
      }
    }
  } catch {
    clearTimeout(timer);
  }

  bbcScoresCache.set(today, {
    expiresAt: Date.now() + 45_000,
    data: results,
  });
  return results;
}

function parseClockToRemainingSeconds(displayClock: string | undefined): number | null {
  if (!displayClock) return null;
  const trimmed = displayClock.trim();
  // Format MM:SS or M:SS
  const mmss = trimmed.match(/^(\d+):(\d{1,2})/);
  if (mmss) {
    return Number(mmss[1]) * 60 + Number(mmss[2]);
  }
  // Format SS.x
  const secs = trimmed.match(/^(\d+(?:\.\d+)?)$/);
  if (secs) {
    return Number(secs[1]);
  }
  return null;
}

export function normalizeClockAndProgress(
  sport: SportType,
  leagueSlug: string,
  statusNode: any,
  homeLinescores?: number[],
  awayLinescores?: number[]
): {
  status: MatchStatus;
  clockLabel: string;
  period: number;
  progressPct: number;
  regulationMinutes?: number;
} {
  const state = statusNode?.type?.state; // 'pre' | 'in' | 'post'
  const completed = Boolean(statusNode?.type?.completed);
  const period = Number(statusNode?.period ?? 0);
  const displayClock: string = statusNode?.displayClock || statusNode?.type?.shortDetail || '';
  const detail: string = statusNode?.type?.shortDetail || statusNode?.type?.detail || '';

  if (state === 'post' || completed) {
    return {
      status: 'finished',
      clockLabel: detail || 'Final',
      period: Math.max(1, period),
      progressPct: 1,
    };
  }

  if (state !== 'in') {
    const shortStart = detail || 'Scheduled';
    return {
      status: 'upcoming',
      clockLabel: shortStart,
      period: 0,
      progressPct: 0,
    };
  }

  if (sport === 'soccer') {
    const minMatch = (displayClock || detail).match(/(\d+)/);
    let mins = minMatch ? Number(minMatch[1]) : period >= 2 ? 60 : 20;
    if (/ht|half/i.test(detail)) mins = 45;
    const pct = clamp(mins / 90, 0.02, 0.99);
    const label = /ht|half/i.test(detail) ? 'HT' : `${mins}'`;
    return { status: 'live', clockLabel: label, period: Math.max(1, period), progressPct: pct, regulationMinutes: 90 };
  }

  if (sport === 'basketball') {
    const isNba = leagueSlug === 'nba';
    const isWnba = leagueSlug === 'wnba';
    const isMbb = leagueSlug === 'mens-college-basketball';
    // NBA: 4x12m (48m), WNBA: 4x10m (40m), NCAAM: 2x20m (40m), NCAAW: 4x10m (40m)
    const numRegPeriods = isMbb ? 2 : 4;
    const periodLenMin = isNba ? 12 : isMbb ? 20 : 10;
    const regTotalMin = numRegPeriods * periodLenMin;
    const remSec = parseClockToRemainingSeconds(displayClock) ?? periodLenMin * 30;
    const clampedPeriod = Math.max(1, period);

    let elapsedMin = 0;
    if (clampedPeriod <= numRegPeriods) {
      elapsedMin = (clampedPeriod - 1) * periodLenMin + (periodLenMin - remSec / 60);
    } else {
      elapsedMin = regTotalMin;
    }

    const pct = clamp(elapsedMin / regTotalMin, 0.02, 0.99);
    let clockLabel = '';
    if (/halftime|half/i.test(detail)) {
      clockLabel = 'HT';
    } else if (clampedPeriod > numRegPeriods) {
      clockLabel = `OT${clampedPeriod - numRegPeriods > 1 ? clampedPeriod - numRegPeriods : ''} ${displayClock}`.trim();
    } else if (isMbb) {
      clockLabel = `${clampedPeriod === 1 ? '1st' : '2nd'} ${displayClock}`.trim();
    } else {
      clockLabel = `Q${clampedPeriod} ${displayClock}`.trim();
    }

    return {
      status: 'live',
      clockLabel,
      period: clampedPeriod,
      progressPct: pct,
      regulationMinutes: regTotalMin,
    };
  }

  if (sport === 'football') {
    const periodLenMin = 15;
    const remSec = parseClockToRemainingSeconds(displayClock) ?? 450;
    const clampedPeriod = Math.max(1, period);
    const elapsedMin =
      clampedPeriod <= 4
        ? (clampedPeriod - 1) * periodLenMin + (periodLenMin - remSec / 60)
        : 60;
    const pct = clamp(elapsedMin / 60, 0.02, 0.99);
    const label = /halftime/i.test(detail)
      ? 'HT'
      : clampedPeriod > 4
        ? `OT ${displayClock}`.trim()
        : `Q${clampedPeriod} ${displayClock}`.trim();
    return {
      status: 'live',
      clockLabel: label,
      period: clampedPeriod,
      progressPct: pct,
      regulationMinutes: 60,
    };
  }

  if (sport === 'hockey') {
    const periodLenMin = 20;
    const remSec = parseClockToRemainingSeconds(displayClock) ?? 600;
    const clampedPeriod = Math.max(1, period);
    const elapsedMin =
      clampedPeriod <= 3
        ? (clampedPeriod - 1) * periodLenMin + (periodLenMin - remSec / 60)
        : 60;
    const pct = clamp(elapsedMin / 60, 0.02, 0.99);
    const ord = clampedPeriod === 1 ? '1st' : clampedPeriod === 2 ? '2nd' : clampedPeriod === 3 ? '3rd' : 'OT';
    const label = /intermission/i.test(detail)
      ? `${ord} Int`
      : `${ord} ${displayClock}`.trim();
    return {
      status: 'live',
      clockLabel: label,
      period: clampedPeriod,
      progressPct: pct,
      regulationMinutes: 60,
    };
  }

  if (sport === 'baseball') {
    const inning = Math.max(1, period);
    const isBot = /bot|bottom/i.test(detail);
    const isMid = /mid/i.test(detail);
    const isEnd = /end/i.test(detail);
    const halfOffset = isBot ? 0.55 : isMid ? 0.5 : isEnd ? 0.95 : 0.15;
    const pct = clamp((inning - 1 + halfOffset) / 9, 0.02, 0.99);
    return {
      status: 'live',
      clockLabel: detail || `Inn ${inning}`,
      period: inning,
      progressPct: pct,
    };
  }

  // Tennis
  const hSets = homeLinescores ?? [];
  const aSets = awayLinescores ?? [];
  const setsPlayed = Math.max(hSets.length, aSets.length, period, 1);
  let completedSets = 0;
  for (let i = 0; i < Math.max(hSets.length, aSets.length); i++) {
    const gH = hSets[i] ?? 0;
    const gA = aSets[i] ?? 0;
    if ((gH >= 6 && gH - gA >= 2) || (gA >= 6 && gA - gH >= 2) || gH === 7 || gA === 7) {
      completedSets++;
    }
  }
  const lastH = hSets[hSets.length - 1] ?? 0;
  const lastA = aSets[aSets.length - 1] ?? 0;
  const curSetFrac = clamp((lastH + lastA) / 10, 0, 0.95);
  const pct = clamp((completedSets + curSetFrac) / 2.5, 0.04, 0.98);
  return {
    status: 'live',
    clockLabel: `Set ${setsPlayed}`,
    period: setsPlayed,
    progressPct: pct,
  };
}

function extractLinescores(competitor: any): number[] {
  const arr = competitor?.linescores;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((ls: any) => Number(ls?.value ?? ls?.displayValue ?? 0))
    .filter((n: number) => Number.isFinite(n));
}

function extractCompetitorName(competitor: any): { name: string; abbrev?: string } {
  if (competitor?.team) {
    return {
      name:
        competitor.team.displayName ||
        competitor.team.shortDisplayName ||
        competitor.team.name ||
        'TBD',
      abbrev: competitor.team.abbreviation,
    };
  }
  if (competitor?.athlete) {
    return {
      name:
        competitor.athlete.displayName ||
        competitor.athlete.shortName ||
        'Player',
      abbrev: competitor.athlete.shortName,
    };
  }
  const rosterAthlete = competitor?.roster?.athletes?.[0];
  if (rosterAthlete) {
    return {
      name: rosterAthlete.displayName || rosterAthlete.shortName || 'Player',
      abbrev: rosterAthlete.shortName,
    };
  }
  return { name: competitor?.displayName || 'TBD' };
}

function parseStatNumeric(raw: any): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const str = String(raw).replace('%', '').trim();
  if (!str) return undefined;
  // Handle "made-attempted" like "12-24" or "4/10" -> take pct if needed or skip
  if (/^\d+[-/]\d+$/.test(str)) return undefined;
  // Handle MM:SS (time of possession)
  const mmss = str.match(/^(\d+):(\d{2})$/);
  if (mmss) {
    return Number(mmss[1]) * 60 + Number(mmss[2]);
  }
  const val = Number.parseFloat(str);
  return Number.isFinite(val) ? val : undefined;
}

export function extractTeamTelemetry(
  sport: SportType,
  statsArray: any[] | undefined,
  linescores?: number[]
): TeamTelemetry {
  const telemetry: TeamTelemetry = {
    linescores: linescores && linescores.length > 0 ? linescores : undefined,
    raw: {},
  };

  if (!Array.isArray(statsArray)) return telemetry;

  // Flatten nested MLB batting/pitching or ESPN category objects
  const flatStats: any[] = [];
  for (const item of statsArray) {
    if (Array.isArray(item?.stats)) {
      for (const nested of item.stats) {
        flatStats.push({ ...nested, _group: item.name || item.type });
      }
    } else if (Array.isArray(item?.statistics)) {
      for (const nested of item.statistics) {
        flatStats.push({ ...nested, _group: item.name || item.type });
      }
    } else {
      flatStats.push(item);
    }
  }

  for (const st of flatStats) {
    const key = String(st?.name || st?.abbreviation || st?.label || '').toLowerCase();
    const displayVal = st?.displayValue ?? st?.value;
    const numVal = parseStatNumeric(st?.value ?? st?.displayValue);
    if (st?.label && displayVal !== undefined) {
      telemetry.raw![String(st.label)] = displayVal;
    }

    if (sport === 'soccer') {
      if (key === 'shotsontarget' || key === 'sot') telemetry.shotsOnTarget = numVal;
      else if (key === 'totalshots' || key === 'shots') telemetry.shots = numVal;
      else if (key === 'woncorners' || key === 'corners') telemetry.corners = numVal;
      else if (key === 'possessionpct' || key === 'possession') telemetry.possessionPct = numVal;
      else if (key === 'redcards') telemetry.redCards = numVal;
      else if (key === 'yellowcards') telemetry.yellowCards = numVal;
      else if (key === 'foulscommitted' || key === 'fouls') telemetry.foulsCommitted = numVal;
    } else if (sport === 'basketball') {
      if (key === 'fieldgoalpct' || key === 'fg%') telemetry.fieldGoalPct = numVal;
      else if (key === 'threepointfieldgoalpct' || key === '3p%') telemetry.threePointPct = numVal;
      else if (key === 'freethrowpct' || key === 'ft%') telemetry.freeThrowPct = numVal;
      else if (key === 'totalrebounds' || key === 'rebounds' || key === 'reb') telemetry.rebounds = numVal;
      else if (key === 'offensiverebounds' || key === 'oreb') telemetry.offensiveRebounds = numVal;
      else if (key === 'assists' || key === 'ast') telemetry.assists = numVal;
      else if (key === 'turnovers' || key === 'totalturnovers' || key === 'to') telemetry.turnovers = numVal;
      else if (key === 'steals' || key === 'stl') telemetry.steals = numVal;
      else if (key === 'blocks' || key === 'blk') telemetry.blocks = numVal;
      else if (key === 'fouls' || key === 'pf') telemetry.fouls = numVal;
    } else if (sport === 'football') {
      if (key === 'totalyards') telemetry.totalYards = numVal;
      else if (key === 'netpassingyards' || key === 'passingyards') telemetry.passingYards = numVal;
      else if (key === 'rushingyards') telemetry.rushingYards = numVal;
      else if (key === 'firstdowns') telemetry.firstDowns = numVal;
      else if (key === 'thirddowneff' || key === 'thirddownpct') {
        if (typeof displayVal === 'string' && displayVal.includes('-')) {
          const [m, a] = displayVal.split('-').map(Number);
          if (a > 0) telemetry.thirdDownPct = Math.round((m / a) * 1000) / 10;
        } else if (numVal !== undefined) {
          telemetry.thirdDownPct = numVal;
        }
      } else if (key === 'turnovers') telemetry.turnovers = numVal;
      else if (key === 'possessiontime') telemetry.timeOfPossessionSec = numVal;
      else if (key === 'sacks') telemetry.sacks = numVal;
    } else if (sport === 'hockey') {
      if (key === 'shots' || key === 'shotsontarget' || key === 'sog') telemetry.shotsOnTarget = numVal;
      else if (key === 'powerplaypct' || key === 'pp%') telemetry.powerPlayPct = numVal;
      else if (key === 'powerplaygoals' || key === 'ppg') telemetry.powerPlayGoals = numVal;
      else if (key === 'faceoffpercent' || key === 'faceoffpct' || key === 'fo%') telemetry.faceoffPct = numVal;
      else if (key === 'hits') telemetry.hits = numVal;
      else if (key === 'blockedshots' || key === 'bs') telemetry.blockedShots = numVal;
      else if (key === 'giveaways') telemetry.giveaways = numVal;
      else if (key === 'takeaways') telemetry.takeaways = numVal;
      else if (key === 'saves') telemetry.saves = numVal;
      else if (key === 'penaltyminutes' || key === 'pim') telemetry.penaltyMinutes = numVal;
    } else if (sport === 'baseball') {
      if (key === 'hits' || key === 'h') telemetry.baseballHits = numVal;
      else if (key === 'avg' || key === 'battingavg') telemetry.battingAvg = numVal;
      else if (key === 'era') telemetry.era = numVal;
      else if (key === 'errors' || key === 'e') telemetry.errors = numVal;
      else if (key === 'strikeouts' || key === 'so') telemetry.strikeoutsPitching = numVal;
      else if (key === 'obp' || key === 'onbasepct') telemetry.onBasePct = numVal;
    } else if (sport === 'tennis') {
      if (key === 'aces') telemetry.aces = numVal;
      else if (key === 'doublefaults') telemetry.doubleFaults = numVal;
      else if (key === 'firstservepct') telemetry.firstServePct = numVal;
    }
  }

  return telemetry;
}

/**
 * Extracts Bookmaker Market Odds from ESPN `pickcenter[0]` / `comp.odds[0]` / `summary.odds[0]`
 * Supports both structured (`moneyline`, `pointSpread`, `total`) and legacy (`overUnder`, `spread`, `awayTeamOdds.moneyLine`, `homeTeamOdds.moneyLine`) schemas.
 * Detects verified live odds nodes (`node.live?.odds` or `oddsNode.live`) vs pre-match/closing prices.
 */
export function extractMarketOdds(
  oddsNodes: any[] | undefined,
  matchStatus: MatchStatus
): { odds?: MarketOdds; hasLiveOddsNode: boolean } {
  if (!Array.isArray(oddsNodes) || oddsNodes.length === 0) {
    return { odds: undefined, hasLiveOddsNode: false };
  }

  // Prefer node with explicit live odds if present
  const primary = oddsNodes.find((n) => Boolean(n?.live?.odds || n?.live)) || oddsNodes[0];
  if (!primary) return { odds: undefined, hasLiveOddsNode: false };

  const liveSub = primary?.live?.odds || (primary?.live && typeof primary.live === 'object' ? primary.live : null);
  const hasLiveOddsNode = Boolean(liveSub);
  const node = liveSub || primary;

  const moneylineHome =
    americanToDecimalOdds(node?.moneyline?.home?.close?.odds) ??
    americanToDecimalOdds(node?.moneyline?.home?.live?.odds) ??
    americanToDecimalOdds(node?.moneyline?.home?.open?.odds) ??
    americanToDecimalOdds(node?.homeTeamOdds?.moneyLine) ??
    americanToDecimalOdds(primary?.homeTeamOdds?.moneyLine);

  const moneylineAway =
    americanToDecimalOdds(node?.moneyline?.away?.close?.odds) ??
    americanToDecimalOdds(node?.moneyline?.away?.live?.odds) ??
    americanToDecimalOdds(node?.moneyline?.away?.open?.odds) ??
    americanToDecimalOdds(node?.awayTeamOdds?.moneyLine) ??
    americanToDecimalOdds(primary?.awayTeamOdds?.moneyLine);

  const moneylineDraw =
    americanToDecimalOdds(node?.moneyline?.draw?.close?.odds) ??
    americanToDecimalOdds(node?.moneyline?.draw?.live?.odds) ??
    americanToDecimalOdds(node?.drawOdds?.moneyLine) ??
    americanToDecimalOdds(primary?.drawOdds?.moneyLine);

  // Spread line (home team handicap)
  const rawSpreadLine =
    node?.pointSpread?.home?.close?.line ??
    node?.pointSpread?.home?.live?.line ??
    node?.spread ??
    primary?.spread;
  const spreadLine =
    rawSpreadLine !== undefined && rawSpreadLine !== null && rawSpreadLine !== ''
      ? Number.parseFloat(String(rawSpreadLine))
      : undefined;

  const spreadHomeOdds =
    americanToDecimalOdds(node?.pointSpread?.home?.close?.odds) ??
    americanToDecimalOdds(node?.pointSpread?.home?.live?.odds) ??
    americanToDecimalOdds(node?.homeTeamOdds?.spreadOdds) ??
    americanToDecimalOdds(primary?.homeTeamOdds?.spreadOdds) ??
    (spreadLine !== undefined ? 1.91 : undefined);

  const spreadAwayOdds =
    americanToDecimalOdds(node?.pointSpread?.away?.close?.odds) ??
    americanToDecimalOdds(node?.pointSpread?.away?.live?.odds) ??
    americanToDecimalOdds(node?.awayTeamOdds?.spreadOdds) ??
    americanToDecimalOdds(primary?.awayTeamOdds?.spreadOdds) ??
    (spreadLine !== undefined ? 1.91 : undefined);

  // Total line
  const rawTotalLine =
    node?.total?.over?.close?.line ??
    node?.total?.over?.live?.line ??
    node?.overUnder ??
    primary?.overUnder;
  const totalLine =
    rawTotalLine !== undefined && rawTotalLine !== null && rawTotalLine !== ''
      ? Number.parseFloat(String(rawTotalLine).replace(/^[ou]/i, ''))
      : undefined;

  const overOdds =
    americanToDecimalOdds(node?.total?.over?.close?.odds) ??
    americanToDecimalOdds(node?.total?.over?.live?.odds) ??
    americanToDecimalOdds(node?.overOdds) ??
    americanToDecimalOdds(primary?.overOdds) ??
    (totalLine !== undefined ? 1.91 : undefined);

  const underOdds =
    americanToDecimalOdds(node?.total?.under?.close?.odds) ??
    americanToDecimalOdds(node?.total?.under?.live?.odds) ??
    americanToDecimalOdds(node?.underOdds) ??
    americanToDecimalOdds(primary?.underOdds) ??
    (totalLine !== undefined ? 1.91 : undefined);

  if (
    !moneylineHome &&
    !moneylineAway &&
    spreadLine === undefined &&
    totalLine === undefined
  ) {
    return { odds: undefined, hasLiveOddsNode };
  }

  return {
    hasLiveOddsNode,
    odds: {
      moneylineHome: moneylineHome ?? undefined,
      moneylineDraw: moneylineDraw ?? undefined,
      moneylineAway: moneylineAway ?? undefined,
      spreadLine: Number.isFinite(spreadLine) ? spreadLine : undefined,
      spreadHomeOdds: spreadHomeOdds ?? undefined,
      spreadAwayOdds: spreadAwayOdds ?? undefined,
      totalLine: Number.isFinite(totalLine) ? totalLine : undefined,
      overOdds: overOdds ?? undefined,
      underOdds: underOdds ?? undefined,
      provider: primary?.provider?.name || 'ESPN Bet',
      isLiveVerified: hasLiveOddsNode && matchStatus === 'live',
      lastUpdated: new Date().toISOString(),
    },
  };
}

function extractPlays(
  summaryJson: any,
  sport: SportType,
  homeTeamId?: string,
  awayTeamId?: string,
  homeName?: string,
  awayName?: string
): PlayEvent[] {
  const rawList: any[] = [];
  if (Array.isArray(summaryJson?.plays)) rawList.push(...summaryJson.plays);
  else if (Array.isArray(summaryJson?.keyEvents)) rawList.push(...summaryJson.keyEvents);
  else if (Array.isArray(summaryJson?.commentary)) rawList.push(...summaryJson.commentary);

  if (rawList.length === 0) return [];

  const totalItems = rawList.length;
  return rawList.slice(-40).map((item, idx) => {
    const teamId = String(item?.team?.id ?? item?.participants?.[0]?.athlete?.team?.id ?? '');
    const text = String(item?.text || item?.shortText || item?.type?.text || '');
    let team: 'home' | 'away' | 'neutral' = 'neutral';
    if (homeTeamId && teamId === homeTeamId) team = 'home';
    else if (awayTeamId && teamId === awayTeamId) team = 'away';
    else if (homeName && text.toLowerCase().includes(homeName.toLowerCase().split(' ')[0])) team = 'home';
    else if (awayName && text.toLowerCase().includes(awayName.toLowerCase().split(' ')[0])) team = 'away';

    const periodNum = Number(item?.period?.number ?? item?.period ?? 1);
    const clock = String(item?.clock?.displayValue ?? item?.time?.displayValue ?? '');
    const elapsedPct = clamp((idx + 1) / Math.max(1, totalItems), 0.02, 0.99);

    const typeText = String(item?.type?.text || item?.type || 'Play');
    let weight = 1.0;
    if (/goal|touchdown|home run|three point|3-pt|ace|break/i.test(typeText + ' ' + text)) {
      weight = 2.4;
    } else if (/shot|attempt|foul|turnover|interception|strikeout|corner/i.test(typeText + ' ' + text)) {
      weight = 1.5;
    }

    if (sport === 'soccer' && /goal/i.test(typeText)) weight = 2.8;

    return {
      id: String(item?.id ?? `${idx}`),
      clock: clock || `P${periodNum}`,
      period: periodNum,
      elapsedPct,
      team,
      type: typeText,
      text: text || typeText,
      weight,
      scoreValue: Number(item?.scoreValue ?? 0) || undefined,
    };
  });
}

/**
 * Parses an ESPN scoreboard event (including Tennis `groupings[].competitions[]`).
 */
export function parseEspnScoreboardEvent(
  ev: any,
  league: LeagueInfo
): ScrapedMatch[] {
  const competitions: any[] = [];

  if (Array.isArray(ev?.competitions) && ev.competitions.length > 0) {
    competitions.push(...ev.competitions);
  }
  if (Array.isArray(ev?.groupings)) {
    for (const grp of ev.groupings) {
      if (Array.isArray(grp?.competitions)) {
        for (const c of grp.competitions) {
          competitions.push({ ...c, _groupingName: grp?.grouping?.displayName });
        }
      }
    }
  }

  const matches: ScrapedMatch[] = [];
  for (const comp of competitions) {
    const competitors: any[] = comp?.competitors ?? [];
    if (competitors.length < 2) continue;

    const homeComp =
      competitors.find((c) => c?.homeAway === 'home') || competitors[0];
    const awayComp =
      competitors.find((c) => c?.homeAway === 'away') || competitors[1];

    const homeIdentity = extractCompetitorName(homeComp);
    const awayIdentity = extractCompetitorName(awayComp);
    const homeLinescores = extractLinescores(homeComp);
    const awayLinescores = extractLinescores(awayComp);

    const statusObj = comp?.status || ev?.status;
    const { status, clockLabel, period, progressPct, regulationMinutes } =
      normalizeClockAndProgress(
        league.sport,
        league.slug,
        statusObj,
        homeLinescores,
        awayLinescores
      );

    // For Tennis, top-level score is often sets won or derived from linescores
    let homeScore = Number.parseFloat(String(homeComp?.score ?? 0));
    let awayScore = Number.parseFloat(String(awayComp?.score ?? 0));
    if (!Number.isFinite(homeScore)) homeScore = 0;
    if (!Number.isFinite(awayScore)) awayScore = 0;

    if (league.sport === 'tennis' && homeScore === 0 && awayScore === 0 && homeLinescores.length > 0) {
      for (let i = 0; i < Math.max(homeLinescores.length, awayLinescores.length); i++) {
        const gH = homeLinescores[i] ?? 0;
        const gA = awayLinescores[i] ?? 0;
        if ((gH >= 6 && gH - gA >= 2) || gH === 7) homeScore++;
        else if ((gA >= 6 && gA - gH >= 2) || gA === 7) awayScore++;
      }
    }

    const homeRecord = homeComp?.records?.[0]?.summary;
    const awayRecord = awayComp?.records?.[0]?.summary;

    const homeStats = extractTeamTelemetry(
      league.sport,
      homeComp?.statistics,
      homeLinescores
    );
    const awayStats = extractTeamTelemetry(
      league.sport,
      awayComp?.statistics,
      awayLinescores
    );

    const { odds, hasLiveOddsNode } = extractMarketOdds(comp?.odds, status);
    const matchId = String(comp?.id || ev?.id);
    registerMatchSportPath(matchId, league.sportPath);

    const bestOfSets: 3 | 5 | undefined =
      league.sport === 'tennis'
        ? Number(comp?.format?.regulation?.periods ?? 3) >= 5
          ? 5
          : 3
        : undefined;

    const draft: ScrapedMatch = {
      id: matchId,
      sport: league.sport,
      league: league.slug,
      leagueName: comp?._groupingName
        ? `${league.name} · ${comp._groupingName}`
        : league.name,
      sportPath: league.sportPath,
      status,
      startTime: String(comp?.date || ev?.date || new Date().toISOString()),
      clockLabel,
      period,
      progressPct,
      regulationMinutes,
      bestOfSets,
      homeTeam: homeIdentity.name,
      awayTeam: awayIdentity.name,
      homeAbbrev: homeIdentity.abbrev,
      awayAbbrev: awayIdentity.abbrev,
      homeScore,
      awayScore,
      homeRecord,
      awayRecord,
      homeStats,
      awayStats,
      plays: [],
      dataQuality: 'record_prior',
      odds,
      hasLiveOddsNode,
    };

    draft.dataQuality = inferDataQuality(draft);
    matchBaseCache.set(matchId, draft);
    matches.push(draft);
  }

  return matches;
}

export function parseEspnSummary(
  summaryJson: any,
  baseMatch: ScrapedMatch
): ScrapedMatch {
  const headerComp = summaryJson?.header?.competitions?.[0];
  const competitors: any[] = headerComp?.competitors ?? [];
  const homeComp = competitors.find((c) => c?.homeAway === 'home') || competitors[0];
  const awayComp = competitors.find((c) => c?.homeAway === 'away') || competitors[1];

  const homeTeamId = String(homeComp?.id || homeComp?.team?.id || '');
  const awayTeamId = String(awayComp?.id || awayComp?.team?.id || '');

  const boxTeams: any[] = summaryJson?.boxscore?.teams ?? [];
  const homeBox =
    boxTeams.find((b) => String(b?.team?.id) === homeTeamId) ||
    boxTeams.find((b) => b?.homeAway === 'home') ||
    boxTeams[1];
  const awayBox =
    boxTeams.find((b) => String(b?.team?.id) === awayTeamId) ||
    boxTeams.find((b) => b?.homeAway === 'away') ||
    boxTeams[0];

  const homeLinescores = extractLinescores(homeComp);
  const awayLinescores = extractLinescores(awayComp);

  const homeStats = {
    ...baseMatch.homeStats,
    ...extractTeamTelemetry(
      baseMatch.sport,
      homeBox?.statistics,
      homeLinescores.length > 0 ? homeLinescores : baseMatch.homeStats.linescores
    ),
  };
  const awayStats = {
    ...baseMatch.awayStats,
    ...extractTeamTelemetry(
      baseMatch.sport,
      awayBox?.statistics,
      awayLinescores.length > 0 ? awayLinescores : baseMatch.awayStats.linescores
    ),
  };

  const plays = extractPlays(
    summaryJson,
    baseMatch.sport,
    homeTeamId,
    awayTeamId,
    baseMatch.homeTeam,
    baseMatch.awayTeam
  );

  const statusObj = headerComp?.status || baseMatch.status;
  const clockParsed =
    headerComp?.status
      ? normalizeClockAndProgress(
          baseMatch.sport,
          baseMatch.league,
          headerComp.status,
          homeStats.linescores,
          awayStats.linescores
        )
      : {
          status: baseMatch.status,
          clockLabel: baseMatch.clockLabel,
          period: baseMatch.period,
          progressPct: baseMatch.progressPct,
          regulationMinutes: baseMatch.regulationMinutes,
        };

  const rawOddsNodes = [
    ...(Array.isArray(summaryJson?.pickcenter) ? summaryJson.pickcenter : []),
    ...(Array.isArray(headerComp?.odds) ? headerComp.odds : []),
    ...(Array.isArray(summaryJson?.odds) ? summaryJson.odds : []),
  ];
  const extracted = extractMarketOdds(rawOddsNodes, clockParsed.status);

  const homeScore =
    homeComp?.score !== undefined
      ? Number.parseFloat(String(homeComp.score))
      : baseMatch.homeScore;
  const awayScore =
    awayComp?.score !== undefined
      ? Number.parseFloat(String(awayComp.score))
      : baseMatch.awayScore;

  const updated: ScrapedMatch = {
    ...baseMatch,
    status: clockParsed.status,
    clockLabel: clockParsed.clockLabel,
    period: clockParsed.period,
    progressPct: clockParsed.progressPct,
    homeScore: Number.isFinite(homeScore) ? homeScore : baseMatch.homeScore,
    awayScore: Number.isFinite(awayScore) ? awayScore : baseMatch.awayScore,
    homeRecord: homeComp?.record?.[0]?.summary || homeComp?.records?.[0]?.summary || baseMatch.homeRecord,
    awayRecord: awayComp?.record?.[0]?.summary || awayComp?.records?.[0]?.summary || baseMatch.awayRecord,
    homeStats,
    awayStats,
    plays: plays.length > 0 ? plays : baseMatch.plays,
    odds: extracted.odds ?? baseMatch.odds,
    hasLiveOddsNode: extracted.hasLiveOddsNode || baseMatch.hasLiveOddsNode,
  };

  updated.dataQuality = inferDataQuality(updated);
  return updated;
}

async function fetchLeagueScoreboard(league: LeagueInfo): Promise<ScrapedMatch[]> {
  const cacheKey = league.sportPath;
  const cached = scoreboardCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const json = await fetchJsonWithFallback(
    `/apis/site/v2/sports/${league.sportPath}/scoreboard`
  );
  if (!json) return [];

  // Record any discovered ESPN league metadata
  if (Array.isArray(json?.leagues)) {
    for (const lg of json.leagues) {
      if (lg?.slug && lg?.name) {
        dynamicLeaguesCache.set(`${league.sport}/${lg.slug}`, {
          slug: lg.slug,
          name: lg.name,
          sport: league.sport,
          sportPath: `${league.sport}/${lg.slug}`,
        });
      }
    }
  }

  const events: any[] = Array.isArray(json?.events) ? json.events : [];
  const parsed: ScrapedMatch[] = [];
  for (const ev of events) {
    parsed.push(...parseEspnScoreboardEvent(ev, league));
  }

  scoreboardCache.set(cacheKey, {
    expiresAt: Date.now() + 20_000,
    data: parsed,
  });

  return parsed;
}

export async function scrapeMatches(
  sportFilter: SportFilter = 'all',
  leagueSlug?: string
): Promise<ScrapedMatch[]> {
  let targetLeagues: LeagueInfo[] = [];

  if (leagueSlug && leagueSlug !== 'all') {
    const found = FULL_LEAGUE_CATALOG.find(
      (l) =>
        l.slug === leagueSlug &&
        (sportFilter === 'all' || l.sport === sportFilter)
    );
    if (found) {
      targetLeagues = [found];
    } else if (sportFilter !== 'all') {
      targetLeagues = [
        {
          slug: leagueSlug,
          name: leagueSlug.toUpperCase(),
          sport: sportFilter,
          sportPath: `${sportFilter}/${leagueSlug}`,
        },
      ];
    } else {
      // Allow soccer slug direct lookup if sportFilter is all
      targetLeagues = [
        {
          slug: leagueSlug,
          name: leagueSlug.toUpperCase(),
          sport: 'soccer',
          sportPath: `soccer/${leagueSlug}`,
        },
      ];
    }
  } else {
    targetLeagues =
      sportFilter === 'all'
        ? CORE_LEAGUES
        : CORE_LEAGUES.filter((l) => l.sport === sportFilter);
  }

  const batches = await Promise.all(
    targetLeagues.map((lg) => fetchLeagueScoreboard(lg))
  );
  let allMatches = batches.flat();

  // Deduplicate by match ID
  const dedup = new Map<string, ScrapedMatch>();
  for (const m of allMatches) {
    dedup.set(m.id, m);
  }
  allMatches = Array.from(dedup.values());

  // BBC live score cross-check for soccer matches
  const hasSoccer = allMatches.some((m) => m.sport === 'soccer');
  if (hasSoccer) {
    const bbcList = await fetchBbcSoccerScores();
    if (bbcList.length > 0) {
      for (const m of allMatches) {
        if (m.sport !== 'soccer') continue;
        const hNorm = normalizeTeamName(m.homeTeam);
        const aNorm = normalizeTeamName(m.awayTeam);
        const hit = bbcList.find(
          (b) =>
            (b.homeNorm.includes(hNorm) || hNorm.includes(b.homeNorm)) &&
            (b.awayNorm.includes(aNorm) || aNorm.includes(b.awayNorm))
        );
        if (hit) {
          m.bbcVerifiedScore = {
            homeScore: hit.homeScore,
            awayScore: hit.awayScore,
            clock: hit.clock,
          };
        }
      }
    }
  }

  // Enrich top live matches (up to 10) with summary boxscore/plays/pickcenter odds in parallel
  const liveToEnrich = allMatches
    .filter((m) => m.status === 'live')
    .slice(0, 10);

  if (liveToEnrich.length > 0) {
    const enriched = await Promise.all(
      liveToEnrich.map((m) => fetchMatchSummary(m.id, m))
    );
    const enrichedMap = new Map(enriched.map((e) => [e.id, e]));
    allMatches = allMatches.map((m) => enrichedMap.get(m.id) ?? m);
  }

  // Sort: live first, then upcoming by startTime, then finished
  const order: Record<MatchStatus, number> = {
    live: 0,
    upcoming: 1,
    finished: 2,
  };
  allMatches.sort((a, b) => {
    if (order[a.status] !== order[b.status]) {
      return order[a.status] - order[b.status];
    }
    return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
  });

  return allMatches;
}

export async function fetchMatchSummary(
  matchId: string,
  fallbackBase?: ScrapedMatch
): Promise<ScrapedMatch> {
  const cached = summaryCache.get(matchId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const base = fallbackBase || matchBaseCache.get(matchId);
  const sportPath = base?.sportPath || getRegisteredSportPath(matchId);
  if (!sportPath) {
    if (base) return base;
    throw new Error(`Unknown sportPath for match ${matchId}`);
  }

  const summaryJson = await fetchJsonWithFallback(
    `/apis/site/v2/sports/${sportPath}/summary?event=${encodeURIComponent(matchId)}`
  );

  if (!summaryJson) {
    if (base) return base;
    throw new Error(`Unable to fetch ESPN summary for match ${matchId}`);
  }

  // If we didn't have a baseMatch (e.g. cold lookup via known sportPath), construct one
  const safeBase: ScrapedMatch =
    base ??
    (() => {
      const [sportStr, slug] = sportPath.split('/');
      const sport = (sportStr as SportType) || 'soccer';
      const headerComp = summaryJson?.header?.competitions?.[0];
      const competitors: any[] = headerComp?.competitors ?? [];
      const h = competitors.find((c) => c?.homeAway === 'home') || competitors[0] || {};
      const a = competitors.find((c) => c?.homeAway === 'away') || competitors[1] || {};
      const hName = extractCompetitorName(h);
      const aName = extractCompetitorName(a);
      return {
        id: matchId,
        sport,
        league: slug || 'unknown',
        leagueName: summaryJson?.header?.league?.name || slug || 'League',
        sportPath,
        status: 'live',
        startTime: headerComp?.date || new Date().toISOString(),
        clockLabel: 'Live',
        period: 1,
        progressPct: 0.5,
        homeTeam: hName.name,
        awayTeam: aName.name,
        homeAbbrev: hName.abbrev,
        awayAbbrev: aName.abbrev,
        homeScore: Number(h?.score ?? 0) || 0,
        awayScore: Number(a?.score ?? 0) || 0,
        homeStats: {},
        awayStats: {},
        plays: [],
        dataQuality: 'record_prior',
      };
    })();

  const enriched = parseEspnSummary(summaryJson, safeBase);
  summaryCache.set(matchId, {
    expiresAt: Date.now() + 15_000,
    data: enriched,
  });
  matchBaseCache.set(matchId, enriched);
  return enriched;
}

export function getCatalogWithDiscovered(sport: SportFilter = 'all'): LeagueInfo[] {
  const merged = new Map<string, LeagueInfo>();
  for (const lg of FULL_LEAGUE_CATALOG) {
    merged.set(lg.sportPath, lg);
  }
  for (const [k, lg] of dynamicLeaguesCache.entries()) {
    if (!merged.has(k)) merged.set(k, lg);
  }
  const all = Array.from(merged.values());
  return sport === 'all' ? all : all.filter((l) => l.sport === sport);
}
