# 포켓몬 배틀 월드 — BGM·환경음 음원 출처 (전곡 CC0)

배틀 BGM 2곡과 속성별 환경음 7종은 모두 **CC0(퍼블릭 도메인 기증)** 음원을 받아
게임 루프용으로만 다듬어(구간 자르기 → 루프 이음새 크로스페이드 → 음량 정규화 → 64kbps MP3)
`public/audio/` 에 정적 파일로 넣은 것입니다. 외부 URL 핫링크를 쓰지 않으므로
403/CORS/느린 로딩 없이 즉시 재생됩니다.

| 파일 | 원본 | 만든 사람 | 라이선스 |
|---|---|---|---|
| `music_battle.mp3` | [JRPG Epic Rock Battle Theme #1](https://opengameart.org/content/jrpg-epic-rock-battle-theme-1) (`jrpg_battle_loop.mp3`) | hydrogene | CC0 |
| `music_boss.mp3` | [Determined Pursuit (epic orchestra loop)](https://opengameart.org/content/determined-pursuit-epic-orchestra-loop) | emmama | CC0 |
| `amb_water.mp3` | [Park ambiences](https://opengameart.org/content/park-ambiences) 중 `park_ambience_river.wav` | thimras | CC0 |
| `amb_fire.mp3` | [Fireplace Sound loop](https://opengameart.org/content/fireplace-sound-loop) | pagdev | CC0 |
| `amb_forest.mp3` | [Park ambiences](https://opengameart.org/content/park-ambiences) 중 `park_ambience_birds.wav` | thimras | CC0 |
| `amb_thunder.mp3` | [Rain + Long Thunder](https://opengameart.org/content/rain-long-thunder) | wuxiascrub | CC0 |
| `amb_ghost.mp3` | [Loopable Dungeon Ambience](https://opengameart.org/content/loopable-dungeon-ambience) (20~54초) | jaggedstone | CC0 |
| `amb_cave.mp3` | [Loopable Dungeon Ambience](https://opengameart.org/content/loopable-dungeon-ambience) (58~92초, 저역 강조 + 잔향) | jaggedstone | CC0 |
| `amb_wind.mp3` | [Park ambiences](https://opengameart.org/content/park-ambiences) 중 `park_ambience_wind.wav` | thimras | CC0 |

## 다듬은 방식

- **음악**: 원본이 설계한 마디 길이(152 BPM 70마디 / 160 BPM 72마디)에 맞춰 자르고,
  끝과 시작을 동일 파워 크로스페이드로 이어 붙여 이음새가 들리지 않는 루프로 만들었습니다.
- **환경음**: 자연 녹음 구간 29~34초를 잘라 같은 방식으로 루프 이음새를 메웠습니다.
- **음량**: EBU R128 기준으로 음악 -18 LUFS / 환경음 -26 LUFS 로 정규화해
  곡이 바뀌어도 튀지 않습니다. 피크는 -3 dBFS 이하로 눌러 두어 겹쳐 재생해도 찢어지지 않습니다.
- **용량**: 음악 885KB·865KB(64kbps), 환경음 352~409KB(96kbps) — 모두 44.1kHz 스테레오 CBR.

CC0 는 저작자 표시 의무가 없지만, 원작자와 출처를 남겨 둡니다.
