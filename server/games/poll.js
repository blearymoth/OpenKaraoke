// "What's next?" crowd poll (PLAN §13.4): four songs, the phones vote for 20 s, the winner is
// queued next (as a sing-along for everyone, or for the host to hand out).
import { Game, decadeIn, fail, intIn, randomInt } from './base.js';

const str = (v, max = 60) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export class Poll extends Game {
  static type = 'poll';
  static label = 'What’s next? poll';
  static exclusive = true;

  static sanitize(c, room) {
    return {
      seconds: intIn(c.seconds, 10, 90, 20),
      songIds: (Array.isArray(c.songIds) ? c.songIds : []).filter((id) => typeof id === 'string' && room.catalog.song(id)).slice(0, 4),
      tag: str(c.tag),
      genre: str(c.genre),
      decade: decadeIn(c.decade),
      singer: c.singer === 'nobody' ? 'nobody' : 'everyone', // who the winner is queued for
    };
  }

  start() {
    const c = this.config;
    const room = this.room;
    const picked = c.songIds.map((id) => this.catalog.song(id));
    const exclude = new Set([...picked.map((s) => s.id), ...room.s.tonight.sung, ...room.s.queue.map((e) => e.songId)]);
    const filter = { exclude, minDuration: 20, maxDuration: 480 }; // no jingles, no 10-minute epics
    if (c.tag) filter.tag = c.tag;
    if (c.genre) filter.genre = c.genre;
    if (c.decade) filter.decade = c.decade;
    if (this.settings.get('queue.explicitFilter')) filter.noExplicit = true;
    const more = this.catalog.random(4 - picked.length, filter);
    this.candidates = [...picked, ...more].slice(0, 4).map((s) => ({ songId: s.id, title: s.title, artist: s.artist }));
    if (this.candidates.length < 2) fail('Not enough songs for a poll — try it without filters.', 'empty');
    this.votes = new Map(); // deviceId → candidate index
    this.winner = -1;
    this.setPhase('vote', c.seconds, () => this.close());
  }

  input(client, m) {
    if (this.phase !== 'vote') fail('Voting has closed.', 'closed');
    const deviceId = client.data.deviceId;
    if (!this.player(deviceId)) fail('Choose a name first.', 'no_profile');
    const choice = m.choice;
    if (!Number.isInteger(choice) || choice < 0 || choice >= this.candidates.length) fail('Pick one of the songs.', 'bad_request');
    this.votes.set(deviceId, choice);
    return { choice };
  }

  action(client, m) {
    if (m.action === 'close' && this.phase === 'vote') return this.close();
    if (m.action === 'end') return this.end();
    return fail('Unknown poll control.');
  }

  counts() {
    const counts = this.candidates.map(() => 0);
    for (const i of this.votes.values()) counts[i]++;
    return counts;
  }

  close() {
    const counts = this.counts();
    const best = Math.max(...counts);
    const top = counts.map((n, i) => (n === best ? i : -1)).filter((i) => i >= 0);
    this.winner = top[randomInt(top.length)]; // ties (and "nobody voted") are drawn by lot
    this.tie = top.length > 1;
    const song = this.catalog.song(this.candidates[this.winner].songId);
    if (song) {
      try {
        const res = this.room.gameQueue(song, { singerName: this.config.singer === 'everyone' ? 'Everyone' : '', position: 'next', source: 'game:poll' });
        this.queuedEntryId = res?.entry?.id || null;
      } catch (e) {
        this.queueError = e.message;
      }
    }
    this.setPhase('result', 8, () => this.end());
    return { winner: this.winner };
  }

  view(ctx) {
    const v = super.view(ctx);
    const counts = this.counts();
    v.seconds = this.config.seconds;
    v.candidates = this.candidates.map((c, i) => ({ ...c, votes: counts[i] }));
    v.total = this.votes.size;
    v.winner = this.phase === 'vote' ? -1 : this.winner;
    v.tie = !!this.tie;
    if (ctx.role === 'guest') v.myVote = this.votes.has(ctx.deviceId) ? this.votes.get(ctx.deviceId) : -1;
    if (ctx.role === 'host') v.queueError = this.queueError || null;
    return v;
  }
}
