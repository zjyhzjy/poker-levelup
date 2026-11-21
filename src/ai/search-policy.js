import { cardScore } from '../cards.js';
import { analyzeShape, cardOrderValue, chooseAiPlay, dealerTeamSeats, determineTrickWinner,
  heuristicActionScores, legalCandidatePlays, playSuit } from '../game.js';
import { ACTION_SIZE, FACES, counts, encodeAction, informationSet, publicEvents, voidSuits } from './learning/observation.js';
import { pimcPairedWorlds, snapshotSearchRoom } from './pimc.js';

export const SEARCH_POLICY_SCHEMA = 'shengji-search-distillation-v1';
export const SEARCH_HAND_LIMIT = 8;
export const SEARCH_MAX_HAND_LIMIT = 12;
export const FULL_PLAY_HAND_LIMIT = 31;
export const SEARCH_CANDIDATE_LIMIT = 8;
export const SEARCH_FEATURE_SIZE = ACTION_SIZE + 26;

const actionKey = cards => cards.map(card => `${card.suit}:${card.rank}`).sort().join(',');
const points = cards => cards.reduce((sum, card) => sum + cardScore(card), 0);
const dot = (left, right) => left.reduce((sum, value, i) => sum + value * right[i], 0);

export function searchPolicyInput(room, viewer) {
  const view = informationSet(room, viewer);
  if (view.phase !== 'playing' || view.turnSeat !== viewer) throw new Error('Not this player’s turn');
  const seat = view.seats[viewer];
  const lead = view.currentTrick[0]?.cards || null;
  const baseline = chooseAiPlay(view, seat, lead);
  const choices = [baseline];
  const keys = new Set([actionKey(baseline)]);
  for (const cards of legalCandidatePlays(view, seat, lead)) {
    const key = actionKey(cards);
    if (keys.has(key)) continue;
    keys.add(key);
    choices.push(cards);
  }
  const heuristicScores = heuristicActionScores(view, seat, choices);
  const ranked = choices.map((cards, index) => ({ cards, score: heuristicScores[index] }));
  const candidates = [ranked[0], ...ranked.slice(1).sort((a, b) => b.score - a.score)]
    .slice(0, SEARCH_CANDIDATE_LIMIT);
  if (candidates.length === 1) return { actions: [baseline], features: [] };

  const teamKnown = view.fixedTeams || view.friendSeat != null;
  const dealers = new Set(dealerTeamSeats(view));
  const relation = index => {
    if (index == null) return 0;
    if (index === viewer) return 1;
    if (!teamKnown) return 0;
    return dealers.has(index) === dealers.has(viewer) ? 1 : -1;
  };
  const trickPoints = view.currentTrick.reduce((sum, play) => sum + play.points, 0);
  const standing = lead ? determineTrickWinner(view, view.currentTrick) : null;
  const standingRelation = relation(standing);
  const seen = counts([...seat.hand, ...view.hiddenKitty, ...publicEvents(view).flatMap(play => play.cards)]);
  const unseen = FACES.map((face, i) => ({
    suit: playSuit(face, view),
    rank: cardOrderValue(face, view),
    count: Math.max(0, view.deckCopies - seen[i])
  })).filter(face => face.count);
  const unknownTrumps = unseen.filter(face => face.suit === 'trump').reduce((sum, face) => sum + face.count, 0);
  const voids = voidSuits(view);
  const opponentsAfter = lead ? view.seatCount - view.currentTrick.length - 1 : view.seatCount - 1;
  const context = [seat.hand.length / 8, Number(!lead), opponentsAfter / 5, trickPoints / 100,
    standingRelation, Number(teamKnown), Number(viewer === view.dealerSeat), Number(viewer === view.friendSeat),
    Math.min(3, view.scores.attackers / 300), Math.min(3, view.scores.dealerTeam / 300),
    seat.hand.filter(card => playSuit(card, view) === 'trump').length / 8,
    Math.max(0, (view.friendCall?.ordinal || 0) - (view.friendCall?.seen || 0)) / 3];

  const features = candidates.map(({ cards, score }, index) => {
    const suit = playSuit(cards[0], view);
    const shape = analyzeShape(cards, view);
    const cardPoints = points(cards);
    const top = Math.max(...cards.map(card => cardOrderValue(card, view)));
    const play = { seat: viewer, cards, shape, points: cardPoints };
    const winner = determineTrickWinner(view, [...view.currentTrick, play]);
    const wins = winner === viewer;
    const higher = unseen.filter(face => face.suit === suit && face.rank > top);
    const groupSize = ['pair', 'triple'].includes(shape.type) ? cards.length : 1;
    const sameSuit = cards.filter(card => playSuit(card, view) === suit).length;
    const remainingSuit = seat.hand.filter(card => playSuit(card, view) === suit).length - sameSuit;
    const leadSuit = lead ? playSuit(lead[0], view) : suit;
    const laterVoids = Array.from({ length: opponentsAfter }, (_, offset) => (viewer + offset + 1) % view.seatCount)
      .filter(index => voids[index].has(leadSuit)).length;
    return [...encodeAction(view, cards), ...context, Number(index === 0), Math.tanh(score / 30),
      Math.tanh((score - candidates[0].score) / 15), cards.length / 8, relation(winner),
      wins ? (trickPoints + cardPoints) / 100 : 0, Number(wins && standingRelation === -1),
      cardPoints / 40, cards.filter(card => playSuit(card, view) === 'trump').length / 8,
      Math.min(2, higher.reduce((sum, face) => sum + face.count, 0) / 8),
      Math.min(1, higher.filter(face => face.count >= groupSize).length / 6),
      unknownTrumps / 24, laterVoids / 5, Number(suit !== 'trump' && remainingSuit === 0)];
  });
  return { actions: candidates.map(candidate => candidate.cards), features };
}

function finiteVector(values, length) {
  return Array.isArray(values) && values.length === length && values.every(Number.isFinite);
}

function validateSearchSettings(search) {
  const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
  const bounded = (value, max) => Number.isFinite(value) && value >= 0 && value <= max;
  if (!search || !integer(search.worlds, 2, 64) || !integer(search.candidates, 2, SEARCH_CANDIDATE_LIMIT) ||
      !integer(search.probeWorlds, 0, search.worlds - 2) || !bounded(search.priorWorlds, 16) ||
      !bounded(search.confidence, 2) || !bounded(search.pointWeight, 1) ||
      !['hard', 'master'].includes(search.rolloutLevel)) throw new Error('Invalid student search settings');
}

export function validateSearchPolicy(model) {
  if (model?.schema !== SEARCH_POLICY_SCHEMA || model.featureSize !== SEARCH_FEATURE_SIZE ||
      !Number.isInteger(model.handLimit) || model.handLimit < SEARCH_HAND_LIMIT ||
      model.handLimit > SEARCH_MAX_HAND_LIMIT || !Array.isArray(model.seatCounts) ||
      !model.seatCounts.length || new Set(model.seatCounts).size !== model.seatCounts.length ||
      !model.seatCounts.every(n => n === 5 || n === 6)) throw new Error('Incompatible search student checkpoint');
  for (const n of model.seatCounts) {
    const policy = model.models?.[n];
    validateRanker(policy, n);
    if (policy.handLimit !== undefined &&
        (!Number.isInteger(policy.handLimit) || policy.handLimit < SEARCH_HAND_LIMIT || policy.handLimit > model.handLimit)) {
      throw new Error(`Invalid ${n}-player search hand limit`);
    }
    if (policy.opening !== undefined) validateRanker(policy.opening, n);
  }
  return model;
}

function validateRanker(policy, seatCount) {
  if (!policy || !Number.isFinite(policy.margin) || policy.margin < 0) throw new Error(`Invalid ${seatCount}-player action margin`);
  if (policy.search !== undefined) validateSearchSettings(policy.search);
  if (policy.kind === 'linear' && finiteVector(policy.coefficients, SEARCH_FEATURE_SIZE)) return;
  const width = policy.weights?.length;
  if (policy.kind === 'tanh' && Array.isArray(policy.weights) && width >= 1 && width <= 128 &&
      policy.weights.every(row => finiteVector(row, SEARCH_FEATURE_SIZE)) &&
      finiteVector(policy.bias, width) && finiteVector(policy.output, width)) return;
  throw new Error(`Invalid ${seatCount}-player student weights`);
}

export function studentScores(policy, features) {
  if (policy.kind === 'linear') return features.map(vector => dot(vector, policy.coefficients));
  return features.map(vector => policy.weights.reduce((sum, row, i) =>
    sum + policy.output[i] * Math.tanh(dot(row, vector) + policy.bias[i]), 0));
}

export function studentChoice(policy, features) {
  if (!features.length) return 0;
  return choiceFromScores(studentScores(policy, features), policy.margin);
}

function choiceFromScores(values, margin) {
  if (values.some(value => !Number.isFinite(value))) throw new Error('Non-finite student action score');
  const best = values.indexOf(Math.max(...values));
  return values[best] - values[0] > margin ? best : 0;
}

export function searchHandLimit(model, seatCount) {
  return model.models[seatCount].handLimit ?? model.handLimit;
}

export function searchPolicyForHand(model, seatCount, handSize) {
  if (!model.seatCounts.includes(seatCount)) return null;
  if (handSize <= searchHandLimit(model, seatCount)) return model.models[seatCount];
  return model.models[seatCount].opening ?? null;
}

function pairedEstimate(rows, candidate, anchor, prior, priorWorlds) {
  let total = 0;
  let squares = 0;
  for (const row of rows) {
    const difference = (row[candidate] - row[anchor]) / 1000;
    total += difference;
    squares += difference * difference;
  }
  const count = rows.length;
  const variance = count > 1 ? Math.max(0, squares - total * total / count) / (count - 1) : 0;
  return {
    value: (total + priorWorlds * prior) / (count + priorWorlds),
    error: count > 1 ? Math.sqrt(variance / count) : Infinity
  };
}

function* studentSearch(room, viewer, input, policy, rng) {
  if (!input.features.length) return 0;
  const scores = studentScores(policy, input.features);
  const anchor = choiceFromScores(scores, policy.margin);
  if (!policy.search) return anchor;
  const config = policy.search;
  const prior = scores.map(score => Math.max(-2, Math.min(2, score - scores[anchor])));
  let candidates = input.actions.map((_, index) => index);
  const searchOptions = { rng, rolloutLevel: config.rolloutLevel, pointWeight: config.pointWeight };
  let probes = 0;
  if (candidates.length > config.candidates) {
    const probeRows = [];
    probes = config.probeWorlds;
    for (const row of pimcPairedWorlds(room, viewer, input.actions, { ...searchOptions, determinizations: probes })) {
      if (row) probeRows.push(row);
      if (yield) return anchor;
    }
    const score = index => probeRows.length
      ? pairedEstimate(probeRows, index, anchor, prior[index], config.priorWorlds).value
      : scores[index];
    const retained = anchor === 0 ? [0] : [anchor, 0];
    const alternatives = candidates.filter(index => !retained.includes(index)).sort((a, b) => score(b) - score(a));
    candidates = [...retained, ...alternatives].slice(0, config.candidates);
  }

  // Use a fresh batch after pruning so an action's lucky probe outcomes cannot
  // also decide the final comparison with the incumbent move.
  const rows = [];
  const actions = candidates.map(index => input.actions[index]);
  const anchorIndex = candidates.indexOf(anchor);
  for (const row of pimcPairedWorlds(room, viewer, actions, { ...searchOptions, determinizations: config.worlds - probes })) {
    if (row) rows.push(row);
    if (yield) break;
  }
  if (rows.length < 2) return anchor;
  let best = anchor;
  let bestScore = 0;
  for (const [index, candidate] of candidates.entries()) {
    if (candidate === anchor) continue;
    const estimate = pairedEstimate(rows, index, anchorIndex, prior[candidate], config.priorWorlds);
    const score = estimate.value - config.confidence * estimate.error;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

export function searchStudentChoice(room, viewer, input, policy, rng = Math.random) {
  const search = studentSearch(room, viewer, input, policy, rng);
  let result = search.next();
  while (!result.done) result = search.next(false);
  return result.value;
}

export function chooseSearchStudentPlay(room, viewer, model, options = {}) {
  if (room.phase !== 'playing' || room.turnSeat !== viewer) return null;
  const policy = searchPolicyForHand(model, room.seatCount, room.seats[viewer].hand.length);
  if (!policy) return null;
  const input = searchPolicyInput(room, viewer);
  if (options.pause && policy.search && input.actions.length > 1) {
    return chooseSearchStudentPlayCooperatively(room, viewer, input, policy, options);
  }
  return input.actions[searchStudentChoice(room, viewer, input, policy, options.rng)];
}

async function chooseSearchStudentPlayCooperatively(room, viewer, input, policy, options) {
  const start = Date.now();
  const timeBudgetMs = options.timeBudgetMs ?? Infinity;
  const search = studentSearch(snapshotSearchRoom(room), viewer, input, policy, options.rng ?? Math.random);
  let result = search.next();
  while (!result.done) {
    await options.pause();
    result = search.next(Date.now() - start >= timeBudgetMs);
  }
  return input.actions[result.value];
}
