// The two chats' addresses (CK-103): `/groups/:id/chat` and
// `/gatherings/:id/chat`, inside the frame. Each is components/ChatView with
// its place, keyed by it: a move from one chat to another is a new page, so
// nothing typed, opened or shown in one is there in the next.
import { useParams } from 'react-router-dom'
import { ChatView } from '../components/ChatView'
import { placeKey, type ChatPlace } from '../lib/chat'

function ChatAt({ kind }: { kind: ChatPlace['kind'] }) {
  const { id } = useParams()
  const place: ChatPlace = { kind, id: id ?? '' }
  return <ChatView key={placeKey(place)} place={place} />
}

export function GroupChat() {
  return <ChatAt kind="group" />
}

export function GatheringChat() {
  return <ChatAt kind="gathering" />
}
