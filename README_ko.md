# Maze Bench

**English version: [Readme](./README.md)**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-yellow.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20this%20project-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/hehee9)

<div align="center">

### [**Interactive Dashboard**](https://hehee9.github.io/maze-bench/public/leaderboard.html)

[![Dashboard](https://img.shields.io/badge/Dashboard-Live-brightgreen?style=for-the-badge&logo=github)](https://hehee9.github.io/maze-bench/public/leaderboard.html)
[![Hugging Face Space](https://img.shields.io/badge/%F0%9F%A4%97-Hugging%20Face%20Space-yellow?style=for-the-badge)](https://huggingface.co/spaces/Hehee-dev/maze-bench)

**위의 두 대시보드 링크에서 리더보드, 모델별 성적 비교, 리플레이 등을 확인하실 수 있습니다**

</div>

---

## 개요

Maze Bench 직사각형의 미로 이미지를 보고 탈출 경로를 출력하는 벤치마크입니다. 연속적 시각+공간 추론 능력을 측정하기 위해 만들어졌습니다. 직사각형 미로 이미지와 정답을 무작위로 생성하고, 모델의 이동 로그를 바탕으로 완성률과 효율성 곱해 채점합니다.

벤치마크에는 쉬움(4x4, 6x6), 보통(9x9, 12x12), 어려움(15x15, 18x18) 미로를 각각 5개씩 사용했습니다. **GPT-5.6 Sol Pro가 66.09점으로 1위를 기록했으며, 나머지 모델 구성은 모두 40점 미만이었습니다.** 비용 관계로 추론을 `medium`으로 제한했기 때문에 추론 강도를 높인다면 결과가 더 개선될 가능성은 있습니다.

---

## 벤치마크 결과

### 리더보드

![리더보드](./images/maze-bench-model-ranking.png)

종합 성적에서는 GPT-5.6 Sol Pro가 66.09점으로 1위를 기록했고, Claude Fable 5가 39.35점으로 뒤를 이었습니다. Kimi K3와 GPT-5.6 Sol은 각각 3위와 4위를 기록했습니다.

한편, 난이도별로 나누어 보면 조금 양상이 다릅니다.

**쉬움**

| 순위 | 모델 | 점수 |
| --- | --- | --- |
| 1 | **GPT-5.6 Sol Pro** | 100.00% |
| 2 | **Claude Fable 5** | 92.54% |
| 3 | **Claude Opus 4.8** | 70.29% |
| 4 | **Gemini 3.5 Flash** | 58.80% |
| 6 | **Kimi K3** | 56.24% |
| 8 | **GPT-5.6 Sol** | 51.24% |

**어려움**

| 순위 | 모델 | 점수 |
| --- | --- | --- |
| 1 | **GPT-5.6 Sol Pro** | 24.54% |
| 2 | **GPT-5.6 Sol** | 16.81% |
| 3 | **Kimi K3** | 14.27% |
| 5 | **Qwen3.7 Plus** | 11.68% |
| 8 | **GPT-5.6 Terra** | 10.40% |
| 11 | **Mimo-V2.5** | 8.94% |
| 12 | **Claude Opus 4.8** | 8.93% |
| 13 | **Claude Fable 5** | 8.34% |

GPT-5.6 Sol Pro는 쉬움·어려움 구간에서 모두 1위를 기록했습니다. 그 아래 순위는 크기에 따라 크게 달라져, **작은 미로**에서는 Claude Fable 5와 Claude Opus 4.8이 상위권에 올랐고 **큰 미로**에서는 GPT-5.6 Sol, Kimi K3와 Qwen3.7 Plus가 그 뒤를 이었습니다.

![크기별_성적](./images/maze-bench-leaderboard-size-scores.png)

위와 같이 그래프로 변환하면 이 현상을 더욱 뚜렷하게 확인할 수 있습니다.

![비용](./images/maze-bench-leaderboard-cost-performance.png)

비용 효율성까지 고려할 경우 미로 벤치는 Claude 계열 모델이 전반적으로 우세하며, GPT와 Kimi는 성적은 높지만 효율성이 비교적 떨어집니다.

---

## 벤치마크의 구성

### 문제 형식

문제는 무작위로 생성된 미로 이미지를 제공한 후 출력 규칙에 따라 한 줄로 된 이동 명령을 출력하도록 되어 있습니다.

![예시_미로_이미지](./maze_sets/9x9/maze_09x09_adjacent_01.png)

만나는 모든 교차점 및 골목길/막다른길에서 이동 방향을 결정해야 하며, 앞(`S`) / 뒤(`B`) / 오른쪽(`R`) / 왼쪽(`L`)으로 이동할 수 있습니다. 모든 방향은 플레이어가 현재 바라보는 방향을 기준으로 합니다. 쭉 이어진 직선 통로는 자동으로 직진하며, 벽이 부딪히면 즉시 이동을 종료합니다.

모델이 최종적으로 `S R L S R R L L ...` 형식의 1줄짜리 문자열을 출력하면 이를 채점합니다. 출력을 코드블록으로 감싸는 것까지는 허용합니다.

지시 프롬프트는 [여기](./scripts/prompt.md)에서 확인 가능합니다.

### 채점 규칙

각 미로의 점수는 `100 × P × E`으로 계산됩니다.

- `P`: 진행도 점수 (`m/(m+r)`)
- `E`: 효율성 점수 (`D/(m+r)`)
- `D`: 출발점에서 도착점까지의 최소(최적) 횟수
- `m`: 벽에 부딪히지 않고 성공적으로 이동한 횟수
- `r`: 최종 이동 위치에서 도착점까지의 최소 이동 횟수

최종 이동 지역 기준으로 측정합니다. 즉, 이동 경로 도중에는 더 좋은 점수를 받을 수 있는 위치가 존재할 수 있습니다.

전체 점수는 모든 미로의 개별 점수의 평균치입니다.

### 시각화 및 리플레이

![리플레이](./images/replay.gif)

[대시보드](https://hehee9.github.io/maze-bench/public/index.html)에서 직접 미로찾기 리플레이를 확인하실 수 있습니다.

최적 경로 오버레이, 여러 모델 동시 재생 등을 지원합니다.

---

## 직접 시도하기

### 설치

Python 3.10 이상이 필요합니다. 필요한 패키지는 다음 명령으로 설치합니다.

```bash
python -m pip install -r requirements.txt
```

### 빠른 시작

`15 × 15` 미로 5개를 생성합니다.

```bash
python scripts/maze_benchmark.py generate --width 15 --height 15 --wall-density 0.8 --image-size 2048 --count 5 --out-dir maze_out --prefix maze
```

같은 옵션으로 실행해도 매번 다른 미로가 생성되며, 사용된 시드는 결과에 기록됩니다.

모델이 출력한 명령을 문제 하나에 채점합니다.

```bash
python scripts/maze_benchmark.py score --problem-json maze_out/maze_001.json --log "S R S L B S"
```

출력을 파일에서 읽으려면 `--log-file model_output.txt`를 사용합니다.

생성된 문제 JSON의 무결성을 검증합니다.

```bash
python scripts/maze_benchmark.py validate --problem-json maze_out/maze_001.json
```

문제 세트 전체를 채점할 때는 문제 ID와 모델 출력을 연결한 JSON 파일을 준비합니다.

```json
{
  "maze_001": "S R S L B S",
  "maze_002": "S L R S S L"
}
```

```bash
python scripts/maze_benchmark.py score-set --manifest maze_out/maze_manifest.json --logs-json model_outputs.json --output scores.json
```

### 생성 옵션과 결과 파일

| 옵션 | 설명 | 기본값 |
|---|---|---:|
| `--width` | 가로 칸 수 | 필수 |
| `--height` | 세로 칸 수 | 필수 |
| `--wall-density` | 벽과 통로의 생성 성향을 조절하는 0~1 값 | `0.7` |
| `--image-size` | 정사각형 이미지의 한 변 길이 | `2048` |
| `--count` | 생성할 문제 수 | `1` |
| `--out-dir` | 결과 디렉터리 | `maze_out` |
| `--prefix` | 문제 ID 접두사 | `maze` |
| `--start-side` | 출발 면: `N`, `E`, `S`, `W` | 무작위 |
| `--goal-side` | 도착 면: `N`, `E`, `S`, `W` | 무작위 |

낮은 벽 밀도는 갈림길과 순환 경로를 늘리고, 높은 벽 밀도는 길고 꼬불꼬불한 복도를 늘립니다. 이 값은 정확한 벽 면적 비율을 뜻하지 않습니다. 출발점과 도착점은 같은 면에 배치될 수 있으며, 열린 2×2 공간은 생성하지 않습니다.

벤치마크 세트에서는 출발 면과 도착 면의 관계를 인접 면(`adjacent`), 대면(`opposite`), 같은 면(`same`)으로 구분해 다양한 경로 유형을 포함합니다.

문제마다 다음 파일이 생성됩니다.

| 파일 | 내용 |
|---|---|
| `.png` | 모델에 입력할 미로 이미지 |
| `.txt` | 사람이 확인할 수 있는 텍스트 미로 |
| `.answer.txt` | 최소 명령 수와 최단 정답 |
| `.json` | 미로 구조와 채점 정보 |
| `.validation.json` | 문제 검증 결과 |

문제 세트에는 파일 경로와 시드를 담은 `<prefix>_manifest.json`도 생성됩니다. 비공개 평가에서는 정답 파일과 채점용 JSON을 모델에 제공하지 마세요.

### API로 일괄 평가

`scripts/run_api_benchmark.py`는 OpenAI Responses, OpenAI Chat Completions 호환 API, Google Gemini REST, Anthropic API를 지원합니다. 이미지는 base64로 직접 전송하며, `scripts/prompt.md`를 사용자 입력에 넣습니다.

먼저 `.env.example`을 `.env`로 복사해 키를 입력합니다. `scripts/models.examples.json`을 `scripts/models.json`으로 복사한 뒤 평가할 모델을 추가합니다. `models.json`은 `.gitignore`에 포함되어 있어 클론 직후에는 존재하지 않습니다.

```json
{
  "models": [
    {
      "name": "Gemini 3.5 Flash (high)",
      "provider": "google",
      "model_id": "gemini-3.5-flash",
      "api_key_env": "GEMINI_API_KEY",
      "max_output_tokens": 65536,
      "rate_limit_rpm": 30,
      "thinking_level": "HIGH",
      "pricing": {
        "input_per_million": null,
        "output_per_million": null
      }
    }
  ]
}
```

지원하는 `provider` 값은 `openai_responses`, `openai_chat`, `google`, `anthropic`입니다. `openai_chat`은 모델별 `base_url`, `extra_body`, `image_url_mode`를 받을 수 있습니다. `google` 제공자는 `service_tier`를 `flex`로 설정합니다.

추론 단계를 조절하는 모델은 API 설정을 이름에 표시합니다(`medium`, `minimal`, `thinking`, `non-thinking` 등). `pricing`은 입력·출력 토큰 **100만 개당 USD 단가**이며, `output_tokens`에는 추론 토큰이 이미 포함됩니다.

```bash
python scripts/run_api_benchmark.py --all-models --dry-run    # 설정 점검
python scripts/run_api_benchmark.py --all-models               # 전체 실행
python scripts/run_api_benchmark.py --models "GPT-5.6 Sol (medium)"
python scripts/run_api_benchmark.py --models "GPT-5.6 Sol (medium)" --maze-sizes 4x4 6x6
python scripts/run_api_benchmark.py --all-models --resume      # 실패·누락만 재시도
python scripts/run_api_benchmark.py --list-models
```

`--all-models`, `--models`, `--list-models` 중 하나를 반드시 지정합니다. `--maze-sizes`로 특정 크기만 실행할 수 있고, `--max-workers`로 동시 호출 수를 조절합니다(기본 30).

개별 결과는 `outputs/<provider>__<model>__<reasoning>__<maze>.json`, 집계는 `outputs/all_model_scores.json`에 저장되며 기본적으로 Git에서 제외됩니다. 프로젝트 루트의 `output/`은 벤치마크와 무관합니다. `--resume`은 호환되는 기존 성공 결과를 재사용하고 실패·누락 항목만 다시 요청합니다.

### Batch API

비동기 Batch API는 별도 실행기를 사용합니다. 현재 Anthropic Message Batches를 지원합니다.

```bash
python scripts/run_batch_benchmark.py --all-models
python scripts/run_batch_benchmark.py --models "Claude Opus 4.8 (medium)" --maze-sizes 9x9
python scripts/run_batch_benchmark.py --all-models --resume
```

모델마다 하나의 배치로 제출한 뒤 기본 60초 간격으로 상태를 확인합니다. `--resume`으로 실패·누락 항목을 이어서 처리합니다. 비용은 일반 API 정가로 계산됩니다.

### 대시보드

대시보드용 데이터는 `public/benchmark_results.json`에 별도로 저장됩니다. 점수·토큰·명령 출력과 집계만 포함하며, 경로·ID·오류문·해시 등 민감 정보는 제외됩니다. `--public-output <경로>`로 위치를 변경할 수 있습니다.

저장소 루트를 정적 HTTP 서버로 제공하면 `public/leaderboard.html`에서 리더보드를, `public/model.html`에서 모델별 결과를, `public/index.html`에서 리플레이를 확인할 수 있습니다.

---

> 연락처: gyugyum@gmail.com
