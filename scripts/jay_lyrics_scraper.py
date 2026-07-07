#!/usr/bin/env python3
"""
Jay Chou (周杰伦) Lyric Scraper
================================
Scrapes ALL song lyrics from QQ Music, organized by album.
Falls back to NetEase Cloud Music when QQ Music lyric API fails.

Usage:
    python scripts/jay_lyrics_scraper.py
    python scripts/jay_lyrics_scraper.py --output ./my_lyrics

Requires: requests, tqdm
"""

from __future__ import annotations

import base64
import json
import logging
import os
import random
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests
from tqdm import tqdm

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("jay_scraper")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SINGER_MID = "0025NhlN2yWrP4"
SINGER_NAME = "周杰伦"
SINGER_ID = 4558

QQ_ALBUM_API = "https://u.y.qq.com/cgi-bin/musicu.fcg"
QQ_ALBUM_SONGS_API = "https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg"
QQ_LYRIC_API = "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg"

NETEASE_SEARCH_API = "https://music.163.com/api/search/get"
NETEASE_LYRIC_API = "https://music.163.com/api/song/lyric"

OUTPUT_DIR = Path("jay_lyrics")
STATE_FILE = "state.json"
STATS_FILE = "stats.json"

MIN_DELAY = 0.8
MAX_DELAY = 1.8
MAX_RETRIES = 3
BASE_BACKOFF = 2.0

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)

EXCLUDED_ALBUM_TYPES = {"现场专辑", "remix"}

EXCLUDED_SONG_PATTERNS = [
    re.compile(r"\(Live.*?\)", re.IGNORECASE),
    re.compile(r"\(Demo.*?\)", re.IGNORECASE),
    re.compile(r"演唱会现场版", re.IGNORECASE),
    re.compile(r"伴奏版$", re.IGNORECASE),
    re.compile(r"\(纯音乐\)", re.IGNORECASE),
]

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


@dataclass
class Album:
    album_mid: str
    album_name: str
    album_type: str
    pub_time: str
    singer_id: int
    song_count: int
    index: int = 0

    @property
    def is_live(self) -> bool:
        return self.album_type in EXCLUDED_ALBUM_TYPES or "现场" in self.album_name

    @property
    def dir_name(self) -> str:
        name = self.album_name.strip()
        name = re.sub(r'[<>:"/\\|?*]', "", name)
        name = re.sub(r"\s+", " ", name)
        name = name.rstrip(". ")
        if not name:
            name = f"unknown_{self.album_mid}"
        return name


@dataclass
class Song:
    songmid: str
    songname: str
    songid: int
    interval: int
    singer_name: str
    album_mid: str
    belong_cd: int = 0

    @property
    def is_primary_singer(self) -> bool:
        return SINGER_NAME in self.singer_name

    @property
    def is_excluded_type(self) -> bool:
        return any(p.search(self.songname) for p in EXCLUDED_SONG_PATTERNS)

    @property
    def safe_filename(self) -> str:
        name = self.songname.strip()
        name = re.sub(r'[<>:"/\\|?*]', "", name)
        name = re.sub(r"\s+", " ", name)
        name = name.rstrip(". ")
        if not name:
            name = f"song_{self.songmid}"
        return name


# ---------------------------------------------------------------------------
# g_tk calculation
# ---------------------------------------------------------------------------


def calc_g_tk(skey: str = "") -> int:
    h = 5381
    for c in skey:
        h = h + (h << 5) + ord(c)
    return h & 0x7FFFFFFF


def generate_guid() -> str:
    return "".join(random.choices("0123456789abcdef", k=16))


def make_qq_headers() -> dict[str, str]:
    return {
        "User-Agent": BROWSER_UA,
        "Referer": "https://y.qq.com/",
        "Origin": "https://y.qq.com",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Cookie": f"guid={generate_guid()}; uin=0;",
    }


def make_netease_headers() -> dict[str, str]:
    return {
        "User-Agent": BROWSER_UA,
        "Referer": "https://music.163.com/",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }


# ---------------------------------------------------------------------------
# Rate limiter
# ---------------------------------------------------------------------------


class RateLimiter:
    def __init__(self, min_delay: float = MIN_DELAY, max_delay: float = MAX_DELAY):
        self.min_delay = min_delay
        self.max_delay = max_delay
        self._last_request: float = 0.0

    def wait(self) -> None:
        now = time.time()
        elapsed = now - self._last_request
        delay = random.uniform(self.min_delay, self.max_delay)
        if elapsed < delay:
            time.sleep(delay - elapsed)
        self._last_request = time.time()


# ---------------------------------------------------------------------------
# Retry helper
# ---------------------------------------------------------------------------


def retry_request(
    func: callable,
    *args,
    max_retries: int = MAX_RETRIES,
    **kwargs,
) -> requests.Response | None:
    last_exc = None
    for attempt in range(max_retries):
        try:
            resp = func(*args, **kwargs)
            if resp.status_code == 200:
                return resp
            elif resp.status_code == 403:
                log.warning(f"HTTP 403 on attempt {attempt + 1}, retrying...")
            elif resp.status_code == 429:
                wait = BASE_BACKOFF * (2**attempt) + random.uniform(0, 2)
                log.warning(f"HTTP 429 rate limited, waiting {wait:.1f}s...")
                time.sleep(wait)
                continue
            else:
                log.warning(f"HTTP {resp.status_code} on attempt {attempt + 1}")
                if attempt == max_retries - 1:
                    return None
        except (requests.ConnectionError, requests.Timeout) as exc:
            last_exc = exc
            log.warning(f"Request failed (attempt {attempt + 1}): {exc}")

        if attempt < max_retries - 1:
            wait = BASE_BACKOFF * (2**attempt) + random.uniform(0, 1)
            time.sleep(wait)

    if last_exc:
        log.error(f"All {max_retries} retries failed: {last_exc}")
    return None


# ---------------------------------------------------------------------------
# QQ Music API Client
# ---------------------------------------------------------------------------


class QQMusicClient:
    def __init__(self, session: requests.Session | None = None):
        self.session = session or requests.Session()
        self.ratelimiter = RateLimiter()

    def _headers(self) -> dict[str, str]:
        return make_qq_headers()

    # ---- Albums ----

    def get_albums(self, singer_mid: str = SINGER_MID) -> list[Album]:
        albums: list[Album] = []
        begin = 0
        page_size = 30
        total = None

        with tqdm(desc="Discovering albums", unit="albums") as pbar:
            while total is None or begin < total:
                payload = {
                    "singerAlbum": {
                        "module": "music.web_singer_info_svr",
                        "method": "get_singer_album",
                        "param": {
                            "singermid": singer_mid,
                            "order": "time",
                            "begin": begin,
                            "num": page_size,
                            "exstatus": 1,
                        },
                    }
                }

                params = {
                    "data": json.dumps(payload, separators=(",", ":")),
                    "format": "json",
                    "platform": "yqq",
                    "g_tk": str(calc_g_tk()),
                }

                headers = self._headers()
                self.ratelimiter.wait()

                resp = retry_request(
                    self.session.get,
                    QQ_ALBUM_API,
                    params=params,
                    headers=headers,
                    timeout=15,
                )

                if resp is None:
                    log.error("Failed to fetch albums, aborting album discovery.")
                    break

                try:
                    data = resp.json()
                except json.JSONDecodeError:
                    log.error(f"Invalid JSON in album response: {resp.text[:200]}")
                    break

                album_data = data.get("singerAlbum", {}).get("data", {})
                if total is None:
                    total = album_data.get("total", 0)
                    pbar.total = total
                    if total == 0:
                        log.warning("No albums found for this singer.")
                        break

                for item in album_data.get("list", []):
                    singers = item.get("singers", [])
                    if singers and singers[0].get("singer_id") != SINGER_ID:
                        log.debug(
                            f"Skipping featured album: {item.get('album_name')}"
                        )
                        continue

                    album = Album(
                        album_mid=item.get("album_mid", ""),
                        album_name=item.get("album_name", "Unknown"),
                        album_type=item.get("albumtype", ""),
                        pub_time=item.get("pub_time", ""),
                        singer_id=item.get("singer_id", 0),
                        song_count=item.get("latest_song", {}).get("song_count", 0),
                        index=len(albums),
                    )
                    albums.append(album)
                    pbar.update(1)

                begin += page_size
                pbar.set_postfix(fetched=len(albums))

        return albums

    # ---- Songs in an album ----

    def get_album_songs(self, album_mid: str) -> list[Song]:
        params = {
            "albummid": album_mid,
            "g_tk": str(calc_g_tk()),
            "format": "json",
            "platform": "yqq",
        }

        headers = self._headers()
        self.ratelimiter.wait()

        resp = retry_request(
            self.session.get,
            QQ_ALBUM_SONGS_API,
            params=params,
            headers=headers,
            timeout=15,
        )

        if resp is None:
            log.error(f"Failed to fetch songs for album {album_mid}")
            return []

        try:
            data = resp.json()
        except json.JSONDecodeError:
            log.error(f"Invalid JSON in album songs response: {resp.text[:200]}")
            return []

        if data.get("code") != 0:
            log.warning(f"Album songs API error: code={data.get('code')}")
            return []

        song_list = data.get("data", {}).get("list", [])
        songs: list[Song] = []

        for item in song_list:
            singers = item.get("singer", [{}])
            primary_singer = singers[0].get("name", "") if singers else ""

            song = Song(
                songmid=item.get("songmid", ""),
                songname=item.get("songname", "Unknown"),
                songid=item.get("songid", 0),
                interval=item.get("interval", 0),
                singer_name=primary_singer,
                album_mid=album_mid,
                belong_cd=item.get("belongCD", 0),
            )
            songs.append(song)

        return songs

    # ---- Lyrics ----

    def get_lyric(self, songmid: str) -> str | None:
        params = {
            "songmid": songmid,
            "g_tk": str(calc_g_tk()),
            "format": "json",
            "platform": "yqq.json",
            "nobase64": "0",
            "loginUin": "0",
            "hostUin": "0",
            "inCharset": "utf8",
            "outCharset": "utf-8",
            "notice": "0",
            "needNewCode": "0",
        }

        headers = self._headers()
        self.ratelimiter.wait()

        resp = retry_request(
            self.session.get,
            QQ_LYRIC_API,
            params=params,
            headers=headers,
            timeout=15,
        )

        if resp is None:
            return None

        try:
            data = resp.json()
        except json.JSONDecodeError:
            text = resp.text.strip()
            match = re.search(r"\{.*\}", text, re.DOTALL)
            if match:
                try:
                    data = json.loads(match.group())
                except json.JSONDecodeError:
                    log.warning(f"Cannot parse lyric response for {songmid}")
                    return None
            else:
                log.warning(f"Non-JSON lyric response: {text[:100]}")
                return None

        if data.get("code") != 0:
            log.debug(f"Lyric API error for {songmid}: code={data.get('code')}")
            return None

        lyric_b64 = data.get("lyric")
        if not lyric_b64:
            log.debug(f"No lyric field in response for {songmid}")
            return None

        try:
            lyric_bytes = base64.b64decode(lyric_b64)
            lyric_text = lyric_bytes.decode("utf-8")
            return lyric_text
        except (base64.binascii.Error, UnicodeDecodeError) as exc:
            log.warning(f"Failed to decode lyric for {songmid}: {exc}")
            return None


# ---------------------------------------------------------------------------
# NetEase Cloud Music API Client (fallback)
# ---------------------------------------------------------------------------


class NetEaseClient:
    def __init__(self, session: requests.Session | None = None):
        self.session = session or requests.Session()
        self.ratelimiter = RateLimiter(min_delay=1.0, max_delay=2.0)

    def _headers(self) -> dict[str, str]:
        return make_netease_headers()

    def search_song(self, songname: str) -> int | None:
        params = {
            "s": f"{SINGER_NAME} {songname}",
            "type": 1,
            "limit": 5,
            "offset": 0,
        }

        headers = self._headers()
        self.ratelimiter.wait()

        resp = retry_request(
            self.session.post,
            NETEASE_SEARCH_API,
            data=params,
            headers=headers,
            timeout=15,
        )

        if resp is None:
            return None

        try:
            data = resp.json()
        except json.JSONDecodeError:
            return None

        songs = data.get("result", {}).get("songs", [])
        for s in songs:
            artists = [a.get("name", "") for a in s.get("artists", [])]
            if SINGER_NAME in artists:
                return s.get("id")

        params2 = {"s": songname, "type": 1, "limit": 10, "offset": 0}
        self.ratelimiter.wait()
        resp2 = retry_request(
            self.session.post,
            NETEASE_SEARCH_API,
            data=params2,
            headers=headers,
            timeout=15,
        )

        if resp2 is None:
            return None

        try:
            data2 = resp2.json()
        except json.JSONDecodeError:
            return None

        songs2 = data2.get("result", {}).get("songs", [])
        for s in songs2:
            artists = [a.get("name", "") for a in s.get("artists", [])]
            if SINGER_NAME in artists:
                return s.get("id")

        return None

    def get_lyric_by_id(self, song_id: int) -> str | None:
        params = {
            "id": song_id,
            "lv": 1,
            "kv": 1,
            "tv": -1,
        }

        headers = self._headers()
        self.ratelimiter.wait()

        resp = retry_request(
            self.session.get,
            NETEASE_LYRIC_API,
            params=params,
            headers=headers,
            timeout=15,
        )

        if resp is None:
            return None

        try:
            data = resp.json()
        except json.JSONDecodeError:
            return None

        if data.get("code") != 200:
            return None

        lrc_text = data.get("lrc", {}).get("lyric", "")
        if not lrc_text:
            return None

        clean = re.sub(r"\[.*?\]", "", lrc_text)
        clean = clean.strip()
        return clean

    def get_lyric(self, songname: str) -> str | None:
        song_id = self.search_song(songname)
        if song_id is None:
            return None
        return self.get_lyric_by_id(song_id)


# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Lyrics formatting utilities
# ---------------------------------------------------------------------------


def strip_lyric_timestamps(lyric_text: str) -> str:
    """Remove LRC timestamps like [00:12.34] from lyric text."""
    # Remove lines that are only metadata (like [ti:...], [ar:...], [al:...], [by:...])
    lines = lyric_text.split("\n")
    clean_lines = []
    for line in lines:
        # Remove metadata tags
        if re.match(r"^\[(ti|ar|al|by|offset|re|ve):", line):
            continue
        # Strip timestamps
        cleaned = re.sub(r"\[.*?\]", "", line).strip()
        if cleaned:
            clean_lines.append(cleaned)
    return "\n".join(clean_lines)

# State Management
# ---------------------------------------------------------------------------


class StateManager:
    def __init__(self, output_dir: Path):
        self.output_dir = output_dir
        self.state_path = output_dir / STATE_FILE
        self.state: dict[str, Any] = self._load()

    def _load(self) -> dict[str, Any]:
        if self.state_path.exists():
            try:
                with open(self.state_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except (json.JSONDecodeError, OSError) as exc:
                log.warning(f"Failed to load state file: {exc}")
        return {
            "version": 1,
            "albums": {},
            "processed_songs": {},
            "failed_songs": {},
        }

    def save(self) -> None:
        self.output_dir.mkdir(parents=True, exist_ok=True)
        tmp_path = self.state_path.with_suffix(".tmp")
        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(self.state, f, ensure_ascii=False, indent=2)
            tmp_path.replace(self.state_path)
        except OSError as exc:
            log.error(f"Failed to save state: {exc}")

    def is_album_done(self, album_mid: str) -> bool:
        return self.state["albums"].get(album_mid, {}).get("status") == "done"

    def is_song_done(self, songmid: str) -> bool:
        return songmid in self.state["processed_songs"]

    def mark_album_started(self, album_mid: str, album_name: str, total: int) -> None:
        self.state["albums"][album_mid] = {
            "name": album_name,
            "status": "started",
            "total": total,
            "done": 0,
        }
        self.save()

    def mark_song_done(self, album_mid: str, songmid: str) -> None:
        self.state["processed_songs"][songmid] = album_mid
        album = self.state["albums"].get(album_mid)
        if album:
            album["done"] = album.get("done", 0) + 1
        self.save()

    def mark_album_done(self, album_mid: str) -> None:
        if album_mid in self.state["albums"]:
            self.state["albums"][album_mid]["status"] = "done"
        self.save()

    def mark_song_failed(self, songmid: str, reason: str) -> None:
        self.state["failed_songs"][songmid] = reason
        self.save()


# ---------------------------------------------------------------------------
# Lyrics Scraper -- Main Orchestrator
# ---------------------------------------------------------------------------


class JayLyricScraper:
    def __init__(
        self,
        output_dir: str | Path = OUTPUT_DIR,
        include_live: bool = False,
        include_demo: bool = False,
        force: bool = False,
    ):
        self.output_dir = Path(output_dir)
        self.include_live = include_live
        self.include_demo = include_demo
        self.force = force

        self.session = requests.Session()
        self.qq = QQMusicClient(self.session)
        self.netease = NetEaseClient(self.session)
        self.state = StateManager(self.output_dir)

        self.stats: dict[str, Any] = {
            "total_albums": 0,
            "total_songs": 0,
            "lyrics_fetched_qq": 0,
            "lyrics_fetched_netease": 0,
            "lyrics_failed": 0,
            "songs_skipped_dup": 0,
            "songs_skipped_excluded": 0,
            "albums_failed": 0,
        }

    def run(self) -> None:
        log.info("=" * 60)
        log.info("Jay Chou (周杰伦) Lyric Scraper")
        log.info("=" * 60)

        start_time = time.time()

        albums = self._discover_albums()
        if not albums:
            log.error("No albums found. Aborting.")
            sys.exit(1)

        log.info(f"Found {len(albums)} albums (after filtering).")

        for album in albums:
            self._process_album(album)

        self._save_stats(time.time() - start_time)
        self.state.save()

        log.info("=" * 60)
        log.info("Done! Summary:")
        log.info(f"  Albums processed: {self.stats['total_albums']}")
        log.info(f"  Songs processed:  {self.stats['total_songs']}")
        log.info(f"  Lyrics (QQ):      {self.stats['lyrics_fetched_qq']}")
        log.info(f"  Lyrics (NetEase): {self.stats['lyrics_fetched_netease']}")
        log.info(f"  Failed:           {self.stats['lyrics_failed']}")
        log.info(f"  Skipped (dup):    {self.stats['songs_skipped_dup']}")
        log.info(f"  Skipped (excl):   {self.stats['songs_skipped_excluded']}")
        log.info(f"  Total time:       {time.time() - start_time:.1f}s")
        log.info(f"  Output:           {self.output_dir.resolve()}")
        log.info("=" * 60)

    def _discover_albums(self) -> list[Album]:
        all_albums = self.qq.get_albums()
        log.info(f"Raw album count from QQ Music: {len(all_albums)}")

        filtered: list[Album] = []
        for album in all_albums:
            if album.is_live and not self.include_live:
                log.info(f"  Skipping live album: {album.album_name}")
                continue
            filtered.append(album)

        filtered.sort(key=lambda a: (a.pub_time or "", a.album_name), reverse=False)
        return filtered

    def _process_album(self, album: Album) -> None:
        log.info(f"\n--- Album: {album.album_name} ({album.pub_time}) ---")

        if self.state.is_album_done(album.album_mid) and not self.force:
            log.info(f"  Already done, skipping.")
            return

        songs = self.qq.get_album_songs(album.album_mid)
        if not songs:
            log.warning(f"  No songs found for album: {album.album_name}")
            self.stats["albums_failed"] += 1
            return

        filtered_songs = self._filter_songs(songs, album)
        if not filtered_songs:
            log.info(f"  All songs filtered out.")
            return

        self.stats["total_albums"] += 1
        self.state.mark_album_started(
            album.album_mid, album.album_name, len(filtered_songs)
        )

        album_dir = self.output_dir / album.dir_name
        album_dir.mkdir(parents=True, exist_ok=True)

        for idx, song in enumerate(
            tqdm(filtered_songs, desc=f"  {album.album_name[:30]}", unit="song")
        ):
            self._process_song(song, album_dir)
            self.state.mark_song_done(album.album_mid, song.songmid)
            self.stats["total_songs"] += 1

        self.state.mark_album_done(album.album_mid)

    def _filter_songs(self, songs: list[Song], album: Album) -> list[Song]:
        filtered: list[Song] = []
        seen_in_album: set[str] = set()

        for song in songs:
            if song.is_excluded_type and not self.include_demo:
                log.debug(f"  Excluding {song.songname} (type)")
                self.stats["songs_skipped_excluded"] += 1
                continue

            if not song.is_primary_singer:
                log.debug(f"  Excluding {song.songname} (not primary singer)")
                self.stats["songs_skipped_excluded"] += 1
                continue

            if self.state.is_song_done(song.songmid) and not self.force:
                existing_album = self.state.state["processed_songs"].get(song.songmid)
                if existing_album and existing_album != album.album_mid:
                    log.debug(
                        f"  Skipping {song.songname} (already in another album)"
                    )
                    self.stats["songs_skipped_dup"] += 1
                    continue

            norm_name = song.songname.strip().lower()
            if norm_name in seen_in_album:
                log.debug(f"  Skipping {song.songname} (duplicate in album)")
                self.stats["songs_skipped_dup"] += 1
                continue
            seen_in_album.add(norm_name)

            filtered.append(song)

        return filtered

    def _process_song(self, song: Song, album_dir: Path) -> None:
        filepath = album_dir / f"{song.safe_filename}.txt"

        if filepath.exists() and not self.force:
            return

        lyric = self.qq.get_lyric(song.songmid)
        source = "qq"

        if not lyric or len(lyric.strip()) < 10:
            log.debug(f"  QQ lyric empty for {song.songname}, trying NetEase...")
            netease_lyric = self.netease.get_lyric(song.songname)

            if netease_lyric and len(netease_lyric.strip()) >= 10:
                lyric = netease_lyric
                source = "netease"
            else:
                alt_name = re.sub(r"\s*\(.*?\)\s*", "", song.songname).strip()
                if alt_name and alt_name != song.songname:
                    netease_lyric2 = self.netease.get_lyric(alt_name)
                    if netease_lyric2 and len(netease_lyric2.strip()) >= 10:
                        lyric = netease_lyric2
                        source = "netease"

        if not lyric or len(lyric.strip()) < 10:
            log.warning(f"  No lyrics found for: {song.songname}")
            self.state.mark_song_failed(song.songmid, "No lyrics from any source")
            self.stats["lyrics_failed"] += 1
            return

        if source == "netease":
            self.stats["lyrics_fetched_netease"] += 1
        else:
            self.stats["lyrics_fetched_qq"] += 1

        # Strip LRC timestamps for clean text output
        clean_lyric = strip_lyric_timestamps(lyric).strip()
        if not clean_lyric:
            clean_lyric = lyric.strip()

        try:
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(clean_lyric)
                f.write("\n")
        except OSError as exc:
            log.error(f"  Failed to write {filepath}: {exc}")
            self.state.mark_song_failed(song.songmid, f"Write error: {exc}")
            self.stats["lyrics_failed"] += 1

    def _save_stats(self, elapsed: float) -> None:
        stats_path = self.output_dir / STATS_FILE
        self.stats["elapsed_seconds"] = round(elapsed, 1)
        self.stats["output_dir"] = str(self.output_dir.resolve())
        try:
            with open(stats_path, "w", encoding="utf-8") as f:
                json.dump(self.stats, f, ensure_ascii=False, indent=2)
        except OSError as exc:
            log.warning(f"Failed to save stats: {exc}")


# ---------------------------------------------------------------------------
# CLI Entry Point
# ---------------------------------------------------------------------------


def parse_args(argv: list[str] | None = None) -> dict[str, Any]:
    args = argv or sys.argv[1:]
    opts: dict[str, Any] = {
        "output_dir": OUTPUT_DIR,
        "include_live": False,
        "include_demo": False,
        "force": False,
        "resume": True,
    }

    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("-h", "--help"):
            print(__doc__)
            sys.exit(0)
        elif arg in ("-o", "--output"):
            i += 1
            if i < len(args):
                opts["output_dir"] = Path(args[i])
        elif arg == "--include-live":
            opts["include_live"] = True
        elif arg == "--include-demo":
            opts["include_demo"] = True
        elif arg == "--force":
            opts["force"] = True
        elif arg == "--clear-state":
            opts["clear_state"] = True
        elif arg == "--debug":
            logging.getLogger().setLevel(logging.DEBUG)
        i += 1

    return opts


def main() -> None:
    opts = parse_args()

    if opts.get("clear_state"):
        state_file = Path(opts["output_dir"]) / STATE_FILE
        if state_file.exists():
            state_file.unlink()
            print(f"State file cleared: {state_file}")
        else:
            print("No state file to clear.")
        return

    scraper = JayLyricScraper(
        output_dir=opts["output_dir"],
        include_live=opts["include_live"],
        include_demo=opts["include_demo"],
        force=opts["force"],
    )

    try:
        scraper.run()
    except KeyboardInterrupt:
        log.info("\nInterrupted by user. Saving state...")
        scraper.state.save()
        log.info("State saved. Run again to resume.")
        sys.exit(1)


if __name__ == "__main__":
    main()


