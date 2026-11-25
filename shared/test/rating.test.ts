import { describe, expect, it } from 'vitest';
import { GLICKO, buildLeaderboard, inflateRd, pairScore, rateMatches, type RatedMatch } from '../src';

const DAY = 86_400_000;
let n = 0;
/** first to `legs` between two players; aLegs/bLegs = final legs */
const duel = (a: string | null, b: string | null, aLegs: number, bLegs: number, at = n * 1000, mode: RatedMatch['mode'] = 'x01'): RatedMatch => ({
  id: `m${n++}`,
  mode,
  at,
  winner: aLegs > bLegs ? 0 : 1,
  players: [
    { userId: a, legs: aLegs },
    { userId: b, legs: bLegs },
  ],
});

describe('rating', () => {
  it('scores a match by result and legs', () => {
    const clear = duel('a', 'b', 3, 0);
    const close = duel('a', 'b', 3, 2);
    expect(pairScore(clear, 0, 1)).toBe(1);
    expect(pairScore(close, 0, 1)).toBeCloseTo(0.8);
    expect(pairScore(close, 1, 0)).toBeCloseTo(0.2);
    expect(pairScore(close, 0, 1)).toBeGreaterThan(0.5); // the winner always scores more than half
  });

  it('moves the winner up and the loser down', () => {
    const r = rateMatches([duel('a', 'b', 3, 1)]);
    expect(r.get('a')!.r).toBeGreaterThan(GLICKO.start);
    expect(r.get('b')!.r).toBeLessThan(GLICKO.start);
    expect(r.get('a')!.rd).toBeLessThan(GLICKO.startRd);
    expect(r.get('a')!).toMatchObject({ matches: 1, wins: 1 });
    expect(r.get('b')!).toMatchObject({ matches: 1, wins: 0 });
  });

  it('a single won match does not put a newcomer above a proven strong player', () => {
    const matches: RatedMatch[] = [];
    // c and d play a lot, c wins three of four
    for (let i = 0; i < 24; i++) matches.push(i % 4 === 3 ? duel('c', 'd', 1, 3) : duel('c', 'd', 3, 1));
    // newcomer a beats newcomer b once (100 % win rate)
    matches.push(duel('a', 'b', 3, 0));
    const r = rateMatches(matches);
    const board = buildLeaderboard(
      'x01',
      ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, displayName: id.toUpperCase() })),
      r,
      new Map(),
    );
    expect(board.map((e) => [e.userId, e.rank])).toEqual([
      ['c', 1],
      ['d', 2],
      ['a', null], // one match: provisional, no place
      ['b', null],
      ['e', null], // never played
    ]);
    expect(board[2]).toMatchObject({ provisional: true, matches: 1, wins: 1 });
    expect(board[2].rating).toBeGreaterThan(GLICKO.start);
    expect(board[4]).toMatchObject({ rating: null, matches: 0, provisional: false });
    // after enough matches the newcomer gets a place
    const more = [...matches];
    for (let i = 0; i < GLICKO.rankedFrom - 1; i++) more.push(duel('a', 'b', 3, 1));
    const later = buildLeaderboard('x01', [{ id: 'a', displayName: 'A' }], rateMatches(more), new Map());
    expect(later[0]).toMatchObject({ rank: 1, provisional: false, matches: GLICKO.rankedFrom });
  });

  it('only players with an account are rated; solo and guest matches change nothing', () => {
    const solo: RatedMatch = { id: 's', mode: 'atc', at: 1, winner: 0, players: [{ userId: 'a', legs: 1 }] };
    const guest = duel('a', null, 3, 0);
    const twice = duel('a', 'a', 3, 0); // same account on two seats
    expect(rateMatches([solo, guest, twice]).size).toBe(0);
  });

  it('ranks three players by result, then legs', () => {
    const m: RatedMatch = {
      id: 'three',
      mode: 'cricket',
      at: 1,
      winner: 1,
      players: [
        { userId: 'a', legs: 1 },
        { userId: 'b', legs: 2 },
        { userId: 'c', legs: 0 },
      ],
    };
    const r = rateMatches([m]);
    expect(r.get('b')!.r).toBeGreaterThan(r.get('a')!.r);
    expect(r.get('a')!.r).toBeGreaterThan(r.get('c')!.r);
  });

  it('keeps the pools apart and adds everything up in "all"', () => {
    const list = [duel('a', 'b', 3, 0, 1, 'x01'), duel('b', 'a', 2, 0, 2, 'cricket'), duel('b', 'a', 2, 1, 3, 'atc')];
    expect(rateMatches(list, 'x01').get('a')!.r).toBeGreaterThan(GLICKO.start);
    expect(rateMatches(list, 'cricket').get('a')!.r).toBeLessThan(GLICKO.start);
    expect(rateMatches(list, 'atc').get('a')!.matches).toBe(1);
    const all = rateMatches(list, 'all');
    expect(all.get('a')!.matches).toBe(3);
    expect(all.get('b')!.r).toBeGreaterThan(all.get('a')!.r);
  });

  it('a win always moves the rating up, a loss down', () => {
    const list: RatedMatch[] = [];
    for (let i = 0; i < 12; i++) {
      list.push(i % 3 ? duel('a', 'b', 3, 2) : duel('a', 'b', 1, 3));
      const last = rateMatches(list);
      const aWon = list[list.length - 1].winner === 0;
      expect(Math.sign(last.get('a')!.lastChange)).toBe(aWon ? 1 : -1);
      expect(Math.sign(last.get('b')!.lastChange)).toBe(aWon ? -1 : 1);
    }
  });

  it('a long break makes the rating move faster again', () => {
    expect(inflateRd(60, 0)).toBe(60);
    expect(inflateRd(60, 365 * DAY)).toBeGreaterThan(200);
    expect(inflateRd(60, 5000 * DAY)).toBe(GLICKO.startRd);
    const base = Array.from({ length: 20 }, () => duel('a', 'b', 3, 2));
    const t = n * 1000;
    const soon = rateMatches([...base, duel('b', 'a', 3, 0, t + DAY)]).get('a')!.lastChange;
    const later = rateMatches([...base, duel('b', 'a', 3, 0, t + 400 * DAY)]).get('a')!.lastChange;
    expect(later).toBeLessThan(soon); // a bigger drop after the break
  });

  it('is independent of the input order', () => {
    const list = [duel('a', 'b', 3, 2, 10), duel('b', 'c', 3, 0, 20), duel('c', 'a', 3, 1, 30)];
    const x = rateMatches(list);
    const y = rateMatches([...list].reverse());
    for (const id of ['a', 'b', 'c']) expect(x.get(id)!.r).toBeCloseTo(y.get(id)!.r, 9);
  });
});
