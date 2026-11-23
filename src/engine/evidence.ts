import type {
  DataQualityTier,
  EvidenceSummary,
  OddsFreeMatchSnapshot,
  SportType,
  TeamTelemetry,
} from '../types/quant';

type BoxLevel = EvidenceSummary['homeBox'];

const PRIMARY_METRICS: Record<SportType, Array<keyof TeamTelemetry>> = {
  soccer: ['shotsOnTarget'],
  basketball: ['fieldGoalPct'],
  football: ['totalYards'],
  hockey: ['shotsOnTarget', 'shots'],
  baseball: ['baseballHits'],
  tennis: ['linescores'],
};

const SECONDARY_METRICS: Record<SportType, Array<keyof TeamTelemetry>> = {
  soccer: ['shots', 'corners', 'possessionPct'],
  basketball: ['threePointPct', 'rebounds', 'turnovers'],
  football: ['passingYards', 'rushingYards', 'firstDowns'],
  hockey: ['powerPlayPct', 'faceoffPct', 'saves'],
  baseball: ['battingAvg', 'era'],
  tennis: ['aces', 'firstServePct', 'doubleFaults'],
};

function hasValue(stats: TeamTelemetry, key: keyof TeamTelemetry): boolean {
  const v = stats[key];
  if (Array.isArray(v)) return v.length > 0;
  return typeof v === 'number' && Number.isFinite(v);
}

export function assessTeamBox(sport: SportType, stats: TeamTelemetry | undefined): BoxLevel {
  if (!stats) return 'none';
  const primary = PRIMARY_METRICS[sport] ?? [];
  const secondary = SECONDARY_METRICS[sport] ?? [];
  const hasPrimary = primary.some((k) => hasValue(stats, k));
  const hasSecondary = secondary.some((k) => hasValue(stats, k));
  if (!hasPrimary && !hasSecondary) return 'none';
  if (hasPrimary && hasSecondary) return 'complete';
  return 'partial';
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isIdentityValid(snapshot: OddsFreeMatchSnapshot): boolean {
  const home = (snapshot.homeTeam ?? '').trim();
  const away = (snapshot.awayTeam ?? '').trim();
  if (!snapshot.id || !home || !away) return false;
  if (normalizeName(home) === normalizeName(away)) return false;
  if (!Number.isFinite(Date.parse(snapshot.startTime))) return false;
  return true;
}

export function assessEvidence(snapshot: OddsFreeMatchSnapshot): EvidenceSummary {
  const homeBox = assessTeamBox(snapshot.sport, snapshot.homeStats);
  const awayBox = assessTeamBox(snapshot.sport, snapshot.awayStats);
  const plays = Array.isArray(snapshot.plays) ? snapshot.plays : [];
  const playsTimed = plays.filter(
    (p) => Number.isFinite(p.elapsedPct) || Number.isFinite(p.elapsedMinutes)
  ).length;
  const identityValid = isIdentityValid(snapshot);

  const notes: string[] = [];
  if (!identityValid) notes.push('match identity invalid: home/away teams indistinct or unverifiable');
  if ((homeBox === 'none') !== (awayBox === 'none')) {
    notes.push('one-sided evidence: only one team has boxscore statistics');
  }
  if (homeBox === 'none' && awayBox === 'none') {
    notes.push('no live boxscore telemetry; record prior only');
  }
  if (plays.length > 0 && playsTimed === 0) {
    notes.push('play-by-play present but untimed; excluded from momentum');
  }

  let tier: DataQualityTier;
  if (!identityValid) {
    tier = 'record_prior';
  } else if (homeBox !== 'none' && awayBox !== 'none' && playsTimed > 0) {
    tier = 'play_by_play_boxscore';
  } else if (homeBox !== 'none' && awayBox !== 'none') {
    tier = 'live_boxscore';
  } else {
    tier = 'record_prior';
  }

  return {
    tier,
    homeBox,
    awayBox,
    playsTimed,
    playsTotal: plays.length,
    identityValid,
    notes,
  };
}

export function inferDataQuality(snapshot: OddsFreeMatchSnapshot): DataQualityTier {
  return assessEvidence(snapshot).tier;
}

/** Confidence is evidence-driven; match progress never raises the tier. */
export function evidenceConfidence(evidence: EvidenceSummary): number {
  const base =
    evidence.tier === 'play_by_play_boxscore'
      ? 0.68
      : evidence.tier === 'live_boxscore'
        ? 0.5
        : 0.3;
  let value = base;
  if (evidence.playsTimed > 0) value += 0.05;
  if (evidence.homeBox === 'partial' || evidence.awayBox === 'partial') value -= 0.05;
  if (!evidence.identityValid) value -= 0.1;
  return Math.max(0.2, Math.min(0.9, value));
}
