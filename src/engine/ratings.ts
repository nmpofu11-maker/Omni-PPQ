/**
 * Elo-style team ratings learned from finished matches. They replace the
 * thin "win-loss record" prior once a team has enough rated games: records
 * ignore opponent strength and are noisy early in a season.
 *
 * Pure functions over a JSON-serialisable RatingBook so the server can persist
 * it inside the existing store.
 */
export interface TeamRating {
  rating: number; // 1500 = league average
  games: number;
}

export interface RatingBook {
  teams: Record<string, TeamRating>;
  /** Finished matches already applied (ring buffer) so a re-poll never double counts. */
  applied: string[];
}

export const INITIAL_RATING = 1500;
const MAX_APPLIED = 5000;

const K_BY_SPORT: Record<string, number> = {
  basketball: 20,
  football: 24,
  soccer: 22,
  hockey: 18,
  baseball: 12,
  tennis: 24,
};
// Elo points of home advantage per sport.
const HOME_ADV_BY_SPORT: Record<string, number> = {
  basketball: 70,
  football: 55,
  soccer: 75,
  hockey: 40,
  baseball: 30,
  tennis: 0,
};

export function emptyRatingBook(): RatingBook {
  return { teams: {}, applied: [] };
}

export function ratingKey(sport: string, team: string): string {
  return `${sport}:${team.trim().toLowerCase()}`;
}

export function eloWinProb(homeRating: number, awayRating: number, homeAdv: number): number {
  return 1 / (1 + Math.pow(10, -(homeRating + homeAdv - awayRating) / 400));
}

export function homeAdvantageElo(sport: string): number {
  return HOME_ADV_BY_SPORT[sport] ?? 40;
}

function marginMultiplier(margin: number, eloDiffWinner: number): number {
  // FiveThirtyEight-style damping so blowouts of favourites do not over-update.
  return Math.log(Math.abs(margin) + 1) * (2.2 / (0.001 * Math.max(0, eloDiffWinner) + 2.2));
}

export function getRating(book: RatingBook | undefined, sport: string, team: string): TeamRating | undefined {
  return book?.teams[ratingKey(sport, team)];
}

/**
 * Apply one finished match. Returns a NEW book (does not mutate) and whether it
 * changed. Ties and non-finite scores are ignored.
 */
export function applyFinishedMatch(
  book: RatingBook,
  match: { id: string; sport: string; homeTeam: string; awayTeam: string; homeScore: number; awayScore: number }
): { book: RatingBook; changed: boolean } {
  if (book.applied.includes(match.id)) return { book, changed: false };
  const { homeScore, awayScore } = match;
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return { book, changed: false };
  if (!match.homeTeam || !match.awayTeam || match.homeTeam === match.awayTeam) return { book, changed: false };

  const hk = ratingKey(match.sport, match.homeTeam);
  const ak = ratingKey(match.sport, match.awayTeam);
  const h = book.teams[hk] ?? { rating: INITIAL_RATING, games: 0 };
  const a = book.teams[ak] ?? { rating: INITIAL_RATING, games: 0 };
  const adv = homeAdvantageElo(match.sport);
  const expectedHome = eloWinProb(h.rating, a.rating, adv);
  const actualHome = homeScore > awayScore ? 1 : homeScore < awayScore ? 0 : 0.5;
  const K = K_BY_SPORT[match.sport] ?? 20;
  const margin = homeScore - awayScore;
  const winnerDiff =
    margin > 0 ? h.rating + adv - a.rating : margin < 0 ? a.rating - (h.rating + adv) : 0;
  const mult = margin === 0 ? 1 : Math.min(2.5, marginMultiplier(margin, winnerDiff));
  const delta = K * mult * (actualHome - expectedHome);

  const applied = [...book.applied, match.id];
  if (applied.length > MAX_APPLIED) applied.splice(0, applied.length - MAX_APPLIED);
  return {
    book: {
      applied,
      teams: {
        ...book.teams,
        [hk]: { rating: h.rating + delta, games: h.games + 1 },
        [ak]: { rating: a.rating - delta, games: a.games + 1 },
      },
    },
    changed: true,
  };
}

/** Rating-implied pre-game home win probability, or null if either side is unrated. */
export function ratingImpliedHomeProb(
  sport: string,
  homeRating: number | undefined,
  awayRating: number | undefined
): number | null {
  if (!Number.isFinite(homeRating) || !Number.isFinite(awayRating)) return null;
  return eloWinProb(homeRating as number, awayRating as number, homeAdvantageElo(sport));
}
