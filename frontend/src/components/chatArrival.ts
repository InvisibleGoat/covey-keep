// Whether the chat that is opening owes its <h1> focus (CK-103): the frame sets
// it where the drawer closes on an address with no menu button to return focus
// to, and the chat spends it once its first read has landed. A ref, never
// state and never navigation state; the next page change clears it, so it is
// owed to no other chat.
import { createContext, type RefObject } from 'react'

export const ChatArrivalContext = createContext<RefObject<boolean> | null>(null)
