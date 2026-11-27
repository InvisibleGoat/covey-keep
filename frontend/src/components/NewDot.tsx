// The dot for something new in a chat (CK-105; THE DESIGN §8): an accent mark
// a screen reader is never told of, and the words it is told instead, after
// the name. Drawn from lib/chatsNew.ts's store alone, which nothing here asks.
import { NEW_MESSAGES } from '../lib/chat'

export function NewWords() {
  return <span className="visually-hidden"> {NEW_MESSAGES}</span>
}

export function NewMark() {
  return <span className="dot" aria-hidden="true" />
}
