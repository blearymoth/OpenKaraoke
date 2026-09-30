// Game screens by type. Each module exports: icon, blurb, Setup (host form), Control (host
// live controls), Tv (full-screen TV scene), optional TvOverlay (drawn over the karaoke),
// and Guest (phone UI). Props: { game, act|send, now (server clock), st/state }.
import * as quiz from './quiz.js';
import * as battle from './battle.js';
import * as wheel from './wheel.js';
import * as poll from './poll.js';
import * as relay from './relay.js';
import * as applause from './applause.js';
import * as recap from './recap.js';

export const GAME_UI = { quiz, battle, wheel, poll, relay, applause, recap };
