/**
 * Anonymous player handle for game leaderboards.
 *
 * A random `adjective-animal-NNNN` label generated once and stored in the
 * metadata table. It is deliberately independent of the telemetry instance ID,
 * user, and machine data, so a leaderboard entry cannot be linked to a person.
 */

import { randomInt } from "node:crypto";
import { getDatabase } from "../db/index.js";
import { getMetadata, setMetadata } from "../db/utils.js";

const PLAYER_HANDLE_KEY = "games.handle";

/** Shape of a valid handle. Also used to vet handles received from the server. */
export const PLAYER_HANDLE_REGEX = /^[a-z]{2,12}-[a-z]{2,12}-\d{4}$/;

const ADJECTIVES = [
  "brave",
  "calm",
  "clever",
  "cosmic",
  "crisp",
  "daring",
  "eager",
  "fancy",
  "fuzzy",
  "gentle",
  "giant",
  "happy",
  "jolly",
  "keen",
  "lucky",
  "merry",
  "mighty",
  "nimble",
  "noble",
  "plucky",
  "proud",
  "quick",
  "quiet",
  "rapid",
  "shiny",
  "silent",
  "sleepy",
  "sneaky",
  "swift",
  "tiny",
  "witty",
  "zesty",
] as const;

const ANIMALS = [
  "badger",
  "beaver",
  "bison",
  "cobra",
  "crane",
  "dingo",
  "eagle",
  "falcon",
  "ferret",
  "gecko",
  "heron",
  "ibis",
  "jaguar",
  "koala",
  "lemur",
  "lynx",
  "marmot",
  "newt",
  "ocelot",
  "otter",
  "panda",
  "parrot",
  "puffin",
  "quokka",
  "raven",
  "salmon",
  "sloth",
  "tapir",
  "toucan",
  "walrus",
  "weasel",
  "wombat",
] as const;

function generateHandle(): string {
  const adjective = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const animal = ANIMALS[randomInt(ANIMALS.length)];
  const suffix = String(randomInt(10_000)).padStart(4, "0");
  return `${adjective}-${animal}-${suffix}`;
}

/** Return the persisted player handle, creating it on first use. */
export function getPlayerHandle(): string {
  const db = getDatabase();
  const existing = getMetadata(db, [PLAYER_HANDLE_KEY]).get(PLAYER_HANDLE_KEY);
  if (existing && PLAYER_HANDLE_REGEX.test(existing)) {
    return existing;
  }

  const handle = generateHandle();
  setMetadata(db, { [PLAYER_HANDLE_KEY]: handle });
  return handle;
}
