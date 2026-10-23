import { useContext } from 'react'
import { AppUpdateContext, type AppUpdateState } from './appUpdate'

export function useAppUpdate(): AppUpdateState {
  const value = useContext(AppUpdateContext)
  if (!value) throw new Error('useAppUpdate must be used inside AppUpdateProvider')
  return value
}
