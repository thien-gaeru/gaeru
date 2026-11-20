"""Prepare GAERU's 20 November 2026 news release and emit SQL; never connect to a database.

prepare --repo ROOT --input WORK reads final.json, the ten public snapshots and covers/.
check|apply --repo ROOT --out FILE reads the packaged manifest and checked WebP files.
rollback --repo ROOT --input WORK --out FILE additionally needs the original public snapshots.
On the destination, run the generated SQL through psql -X -v ON_ERROR_STOP=1.
"""
import argparse
import base64
import hashlib
import json
import re
import shutil
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit
from uuid import UUID, NAMESPACE_URL, uuid5


RELEASE = "news-guides-20261120"
MANIFEST = Path("content") / (RELEASE + ".json")
ASSETS = Path("assets/news/guides-20261120")
FIELDS = ["title", "excerpt", "body", "imageAlt"]
LIMITS = [(5, 180), (10, 400), (30, 20000), (3, 250)]


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fields(record):
    return [record[name] for name in FIELDS]


def hashes(values):
    return [digest(v.encode("utf-8")) for v in values]


def require(condition, explanation):
    if not condition:
        raise ValueError(explanation)


def image_bytes(path):
    data = path.read_bytes()
    require(20 <= len(data) <= 5 * 1024 * 1024 and data[:4] == b"RIFF"
            and data[8:12] == b"WEBP" and int.from_bytes(data[4:8], "little") + 8 == len(data),
            f"Expected a complete WebP up to 5 MiB: {path.name}")
    return data


def valid_slug(slug):
    require(len(slug) <= 120 and re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug),
            "Invalid news slug")


def image_sources(record):
    items = record.get("imageSources")
    require(isinstance(items, list) and items, "Missing original product image sources: " + record["slug"])
    result = []
    seen = set()
    for item in items:
        page = item["sourcePage"]
        image = item["sourceImage"]
        checksum = item["sha256Original"].lower()
        require(re.fullmatch(r"https://gaeru\.com/san-pham/[a-z0-9]+(?:-[a-z0-9]+)*", page),
                "Expected a canonical GAERU product page: " + page)
        url = urlsplit(image)
        asset_path = re.fullmatch(r"/assets/products/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\.(?:webp|avif|jpeg|jpg|png)", url.path)
        catalog_path = re.fullmatch(r"/api/catalog-images/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", url.path)
        query = parse_qsl(url.query, keep_blank_values=True, strict_parsing=True)
        require(url.scheme == "https" and url.netloc == "gaeru.com" and not url.fragment
                and (asset_path or catalog_path) and all(k in {"v", "w", "format"} and
                re.fullmatch(r"[A-Za-z0-9_.-]+", v) for k, v in query),
                "Expected an official same-origin catalog image: " + image)
        require(re.fullmatch(r"[0-9a-f]{64}", checksum),
                "Invalid original image SHA-256: " + image)
        require((page, image) not in seen, "Duplicate original image record: " + image)
        seen.add((page, image))
        result.append({"sourcePage":page, "sourceImage":image, "sha256Original":checksum})
    return result


def prepare(repo, folder):
    articles = load(folder / "final.json")
    expected = load(folder / "list.json")
    require(len(articles) == 10 and [r["slug"] for r in articles] == [r["slug"] for r in expected],
            "The final manifest must contain exactly the ten snapshot slugs in feed order.")
    result = []
    for final, listed in zip(articles, expected):
        slug = final["slug"]
        valid_slug(slug)
        before = load(folder / (slug + ".json"))["post"]
        require(all(before[key] == listed[key] for key in
                    ["id", "slug", "publishedAt", "version", "coverId", "updatedAt"])
                and before["status"] == "published", "Inconsistent public snapshot: " + slug)
        asset = ASSETS / (slug + ".webp")
        raw = image_bytes(folder / "covers" / asset.name)
        original = fields(before)
        final_text = fields(final)
        for key, value, (lower, upper) in zip(FIELDS, final_text, LIMITS):
            require(isinstance(value, str) and lower <= len(value.strip()) <= upper and value == value.strip(),
                    f"Invalid {key} in {slug}")
        cover_digest = digest(raw)
        cover = str(UUID(final["coverId"])) if final.get("coverId") else str(
            uuid5(NAMESPACE_URL, "https://gaeru.com/tin-tuc/" + slug + "?cover=" + RELEASE + "-" + cover_digest))
        result.append({
            "id": str(UUID(before["id"])), "slug": slug, "publishedAt": before["publishedAt"],
            "beforeVersion": before["version"], "beforeUpdatedAt": before["updatedAt"],
            "beforeCover": str(UUID(before["coverId"])), "beforeHashes": hashes(original),
            **dict(zip(FIELDS, final_text)), "coverId": cover, "coverPath": asset.as_posix(),
            "coverSha256": cover_digest, "imageSources": image_sources(final)
        })
    require(all(len({r[key] for r in result}) == 10 for key in ["slug", "id", "coverId"])
            and {r["coverId"] for r in result}.isdisjoint(r["beforeCover"] for r in result),
            "Duplicate identifiers or reuse of an original image identifier")
    for r in result:
        dest = repo / r["coverPath"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(folder / "covers" / dest.name, dest)
    manifest = repo / MANIFEST
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps({"release": RELEASE, "posts": result}, ensure_ascii=False,
                                   indent=2) + "\n", encoding="utf-8")


def quote_json(value):
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    tag = "$news_release$"
    require(tag not in text, "Reserved SQL delimiter in publication content")
    return tag + text + tag


def emit(repo, folder, mode):
    package = load(repo / MANIFEST)
    require(package["release"] == RELEASE and len(package["posts"]) == 10, "Unexpected release manifest")
    rows = []
    for r in package["posts"]:
        slug = r["slug"]
        valid_slug(slug)
        image_sources(r)
        require(r["coverPath"] == (ASSETS / (slug + ".webp")).as_posix(), "Unexpected image path")
        image_data = None
        if mode == "apply":
            data = image_bytes(repo / r["coverPath"])
            require(digest(data) == r["coverSha256"], "Cover bytes differ from manifest: " + slug)
            image_data = base64.b64encode(data).decode()
        new = fields(r)
        old = None
        if mode == "rollback":
            snap = load(folder / (slug + ".json"))["post"]
            old = fields(snap)
            require(snap["id"] == r["id"] and snap["coverId"] == r["beforeCover"]
                    and snap["version"] == r["beforeVersion"] and hashes(old) == r["beforeHashes"],
                    "Rollback snapshot no longer matches: " + slug)
        rows.append({
            "id": r["id"], "slug": slug, "pub": r["publishedAt"], "v": r["beforeVersion"],
            "old_updated": r["beforeUpdatedAt"], "old_cover": r["beforeCover"],
            "new_cover": r["coverId"], "old_hashes": r["beforeHashes"], "new_hashes": hashes(new),
            "image_sha": r["coverSha256"], "image_data": image_data,
            "replacement": old if mode == "rollback" else new
        })
    return SQL.replace("@MODE@", mode).replace("@ROWS@", quote_json(rows))


SQL = """-- GAERU editorial release. Run as an explicit psql script, never as a startup migration.
BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '90s';
CREATE TEMP TABLE gaeru_editorial ON COMMIT DROP AS
SELECT * FROM jsonb_to_recordset(@ROWS@::jsonb) AS r(
    id uuid, slug text, pub timestamptz, v integer, old_updated timestamptz, old_cover uuid,
    new_cover uuid, old_hashes text[], new_hashes text[], image_sha text, image_data text, replacement text[]);
ALTER TABLE gaeru_editorial ADD PRIMARY KEY (id), ADD UNIQUE (slug), ADD UNIQUE (new_cover);
DO $news_change$
DECLARE
    mode constant text := '@MODE@';
    release_name constant text := 'news-guides-20261120';
    originals int; published int; restored int; matched int;
BEGIN
    -- Acquire rows in the same order for retries and concurrent editors.
    IF mode<>'check' THEN
        PERFORM p.id FROM news_posts p JOIN gaeru_editorial r ON r.id=p.id ORDER BY p.id FOR UPDATE OF p;
    END IF;
    SELECT count(*) FILTER (WHERE p.version=r.v AND p.cover_id=r.old_cover AND x.hashes=r.old_hashes
                                  AND date_trunc('milliseconds',p.updated_at)=r.old_updated),
           count(*) FILTER (WHERE p.version=r.v+1 AND p.cover_id=r.new_cover AND x.hashes=r.new_hashes),
           count(*) FILTER (WHERE p.version=r.v+2 AND p.cover_id=r.old_cover AND x.hashes=r.old_hashes)
      INTO originals,published,restored
      FROM gaeru_editorial r JOIN news_posts p ON p.id=r.id AND p.slug=r.slug
      CROSS JOIN LATERAL (SELECT ARRAY[
        encode(sha256(convert_to(p.title,'UTF8')),'hex'),encode(sha256(convert_to(p.excerpt,'UTF8')),'hex'),
        encode(sha256(convert_to(p.body,'UTF8')),'hex'),encode(sha256(convert_to(p.image_alt,'UTF8')),'hex')
      ] AS hashes) x
     WHERE p.status='published' AND date_trunc('milliseconds',p.published_at)=r.pub;
    IF mode='rollback' AND (originals=10 OR restored=10) THEN
        RAISE NOTICE 'Original articles already present'; RETURN;
    END IF;
    IF (mode IN ('check','apply') AND originals<>10 AND published<>10)
       OR (mode='rollback' AND published<>10) THEN
        RAISE EXCEPTION 'Editorial release cancelled (original %, published %, restored %)', originals,published,restored;
    END IF;
    IF mode='apply' AND originals=10 THEN
        WITH added AS (
            INSERT INTO news_images (id,content,mime_type)
            SELECT new_cover,decode(image_data,'base64'),'image/webp' FROM gaeru_editorial
            ORDER BY new_cover ON CONFLICT (id) DO NOTHING RETURNING id,octet_length(content) AS size
        )
        INSERT INTO audit_events(actor_username,actor_name,actor_source,actor_role,action,entity_type,entity_id,metadata)
        SELECT release_name,'GAERU editorial release','system','system','news.image.upload','news_image',id::text,
               jsonb_build_object('release',release_name,'size',size) FROM added;
    END IF;
    -- Existing rows may only be reused if the bytes and declared type agree.
    IF mode<>'check' THEN
        PERFORM i.id FROM news_images i JOIN gaeru_editorial r ON r.new_cover=i.id ORDER BY i.id FOR SHARE OF i;
    END IF;
    IF EXISTS(SELECT FROM news_images i JOIN gaeru_editorial r ON r.new_cover=i.id WHERE
        i.mime_type<>'image/webp' OR encode(sha256(i.content),'hex')<>r.image_sha) THEN
        RAISE EXCEPTION 'Editorial image ID conflict or changed image bytes';
    END IF;
    IF published=10 OR mode='apply' THEN
        SELECT count(*) INTO matched FROM news_images i JOIN gaeru_editorial r ON r.new_cover=i.id;
        IF matched<>10 THEN RAISE EXCEPTION 'Missing editorial images'; END IF;
    END IF;
    IF mode='check' OR (mode='apply' AND published=10) THEN
        RAISE NOTICE 'Validated ten articles; original %, published %', originals,published; RETURN;
    END IF;
    WITH changed AS (
        UPDATE news_posts p SET title=r.replacement[1],excerpt=r.replacement[2],body=r.replacement[3],
               image_alt=r.replacement[4],cover_id=CASE WHEN mode='apply' THEN r.new_cover ELSE r.old_cover END,
               version=p.version+1,updated_at=now()
          FROM gaeru_editorial r WHERE r.id=p.id RETURNING p.id,p.version
    )
    INSERT INTO audit_events(actor_username,actor_name,actor_source,actor_role,action,entity_type,entity_id,metadata)
    SELECT release_name,'GAERU editorial release','system','system','news.update','news_post',id::text,
           jsonb_build_object('release',release_name,'operation',mode,'status','published','version',version)
      FROM changed;
    GET DIAGNOSTICS matched=ROW_COUNT;
    IF matched<>10 THEN RAISE EXCEPTION 'Expected ten updated articles, found %', matched; END IF;
    RAISE NOTICE 'Editorial % complete for ten articles',mode;
END;
$news_change$;
COMMIT;
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["prepare", "check", "apply", "rollback"])
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if args.mode in ("prepare", "rollback") and args.input is None:
        parser.error("--input is required to read the public snapshots")
    if args.mode == "prepare":
        prepare(args.repo, args.input)
    else:
        if args.out is None:
            parser.error("--out is required for generated SQL")
        args.out.write_text(emit(args.repo,args.input,args.mode), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
