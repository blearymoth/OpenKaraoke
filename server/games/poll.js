// Crowd poll "What's next?" (PLAN §13.4): 2–6 candidate songs, phones vote, winner can be queued.

export const POLL_DEFAULTS = { seconds: 20, count: 4, tag: '' };

export class PollGame {
  static type = 'poll';

  /**
   * @param {object} o
   * @param {object[]} o.songs candidate song summaries { id, title, artist, dur }
   * @param {number} o.seconds voting time
   */
  constructor({ songs, seconds = 20, now = Date.now, rng = Math.random, onChange = () => {} }) {
    if (!songs || songs.length < 2) throw new Error('A poll needs at least two songs');
    this.id = Math.random().toString(36).slice(2, 10);
    this.songs = songs.slice(0, 6);
    this.seconds = Math.max(5, Math.min(120, Number(seconds) || 20));
    this.now = now;
    this.rng = rng;
    this.onChange = onChange;
    this.votes = new Map(); // voter id -> option index
    this.phase = 'voting';
    this.endsAt = now() + this.seconds * 1000;
    this.winner = null;
    this.timer = setTimeout(() => this.close(), this.seconds * 1000);
    this.timer.unref?.();
  }

  vote(voter, option) {
    if (this.phase !== 'voting') throw new Error('Voting has closed');
    const i = Number(option);
    if (!Number.isInteger(i) || i < 0 || i >= this.songs.length) throw new Error('Unknown option');
    this.votes.set(voter, i);
    this.onChange();
    return i;
  }

  counts() {
    const c = new Array(this.songs.length).fill(0);
    for (const i of this.votes.values()) c[i]++;
    return c;
  }

  /** Ends voting; ties are broken at random. */
  close() {
    if (this.phase !== 'voting') return this.winner;
    clearTimeout(this.timer);
    const c = this.counts();
    const top = Math.max(...c);
    const leaders = c.map((n, i) => (n === top ? i : -1)).filter((i) => i >= 0);
    this.winner = leaders[Math.floor(this.rng() * leaders.length)];
    this.phase = 'result';
    this.onChange();
    return this.winner;
  }

  action(name) {
    if (name === 'close') return this.close();
    throw new Error(`Unknown poll action ${name}`);
  }

  view(voter = null) {
    const v = {
      id: this.id,
      type: 'poll',
      phase: this.phase,
      endsAt: this.endsAt,
      seconds: this.seconds,
      options: this.songs.map((s) => ({ songId: s.id, title: s.title, artist: s.artist, dur: s.dur })),
      counts: this.counts(),
      voters: this.votes.size,
      winner: this.winner,
    };
    if (voter) v.myVote = this.votes.has(voter) ? this.votes.get(voter) : null;
    return v;
  }

  winnerSong() {
    return this.winner == null ? null : this.songs[this.winner];
  }

  dispose() {
    clearTimeout(this.timer);
  }
}
