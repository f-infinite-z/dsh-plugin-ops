import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'
import { DEFAULT_CONFIG_FILENAME } from './config.js'

export const MEMORY_DIR_NAME = 'dsh-ops'
export const MEMORY_FILENAME = 'memory.jsonl'
export const KNOWLEDGE_DIR_NAME = 'knowledge'

export interface DshPaths {
  home: string
  profilesDir: string
  profileDir: string
  profileManifest: string
  memoryDir: string
  memoryFile: string
  knowledgeDir: string
  sharedProfilesDir: string
  configFile: string
}

export function resolveDshPaths(profileName: string, configuredHome?: string): DshPaths {
  const home = resolveDshHome(configuredHome)
  const profilesDir = join(home, 'profiles')
  const profileDir = join(profilesDir, profileName)
  const memoryDir = join(home, 'cache', MEMORY_DIR_NAME)
  return {
    home,
    profilesDir,
    profileDir,
    profileManifest: join(profileDir, 'package.json'),
    memoryDir,
    memoryFile: join(memoryDir, MEMORY_FILENAME),
    knowledgeDir: join(memoryDir, KNOWLEDGE_DIR_NAME),
    sharedProfilesDir: join(profilesDir, 'node_modules'),
    configFile: join(home, DEFAULT_CONFIG_FILENAME),
  }
}
