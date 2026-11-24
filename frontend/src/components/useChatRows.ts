// A chat's elements by its message's id (CK-103): its row, the word it carries
// and a held row's button, for focus and for the thread's place. One ref
// function per id for the life of the page, so a message that has not changed
// is never drawn again for its ref.
import { useState } from 'react'

export interface Kept<E extends HTMLElement> {
  ref: (id: string) => (element: E | null) => void
  get: (id: string) => E | null
}

export interface ChatRows {
  row: Kept<HTMLLIElement>
  word: Kept<HTMLButtonElement>
  toggle: Kept<HTMLButtonElement>
}

function keep<E extends HTMLElement>(): Kept<E> {
  const elements = new Map<string, E>()
  const refs = new Map<string, (element: E | null) => void>()
  return {
    ref(id) {
      let ref = refs.get(id)
      if (ref === undefined) {
        ref = (element) => void (element === null ? elements.delete(id) : elements.set(id, element))
        refs.set(id, ref)
      }
      return ref
    },
    get: (id) => elements.get(id) ?? null,
  }
}

export function useChatRows(): ChatRows {
  const [rows] = useState<ChatRows>(() => ({ row: keep(), word: keep(), toggle: keep() }))
  return rows
}
