import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Writable } from "node:stream";
import sharp from "sharp";
import { Hono } from "hono";

const PORT = 6769;

const webhooks = {};
const users = new Map<string, keyof typeof webhooks>([]);
const app = new Hono();

function getInstagramGraphQL(shortcode: string): string {
  return `https://www.instagram.com/graphql/query/?doc_id=24368985919464652&variables={"shortcode":"${shortcode}","fetch_tagged_user_count":null,"hoisted_comment_id":null,"hoisted_reply_id":null}`;
}

type InstagramAsset =
  | Carousel
  | {
      type: "image" | "video";
      link: string;
    };

type Carousel = {
  type: "carousel";
  assets: (Exclude<InstagramAsset, Carousel> & { index: number })[];
};

async function getAssets(shortcode: string): Promise<InstagramAsset | null> {
  console.log(`[info] - ${shortcode} - fetching`);

  const res = await fetch(getInstagramGraphQL(shortcode));
  if (!res.ok) {
    console.log(`[info] - ${shortcode} - status code: ${res.status}`);
    return null;
  }
  const json = (await res.json()).data.xdt_api__v1__media__shortcode__web_info.items[0];
  if (json.carousel_media_count && json.carousel_media_count > 0 && json.carousel_media) {
    let v_count = 0;
    let i_count = 0;
    const res = {
      type: "carousel",
      assets: (json.carousel_media as any[]).map((e, index) => {
        if (e.media_type == 2 && e.video_versions != null) {
          v_count++;
          const videos = e.video_versions;
          (videos as Array<any>).sort((a, b) => b.height * b.width - a.height * a.width);
          return { type: "video", link: videos[0].url, index } as const;
        } else {
          i_count++;
          const images = e.image_versions2.candidates;
          (images as Array<any>).sort((a, b) => b.height * b.width - a.height * a.width);
          return { type: "image", link: images[0].url, index } as const;
        }
      }),
    } as const;
    console.log(
      `[info] - ${shortcode} - detected ${[`${i_count} image${i_count > 1 ? "s" : ""}`, `${v_count} video${v_count > 1 ? "s" : ""}`].join(" and ")}`,
    );

    return res;
  }
  if (json.media_type == 2 && json.video_versions != null && json.video_versions.length > 0) {
    console.log(`[info] - ${shortcode} - detected 1 video`);
    const sel = (json.video_versions as Array<any>).sort(
      (a, b) => b.height * b.width - a.height * a.width,
    )[0];
    return {
      type: "video",
      link: sel.url,
    };
  }

  if (
    json.media_type == 1 &&
    json.image_versions2 != null &&
    json.image_versions2.candidates != null
  ) {
    console.log(`[info] - ${shortcode} - detected 1 image`);

    const sel = (json.image_versions2.candidates as Array<any>).sort(
      (a, b) => b.height * b.width - a.height * a.width,
    )[0];
    return {
      type: "image",
      link: sel.url,
    };
  }
  console.log(`[info] - ${shortcode} - did not detect`);

  return null;
}

function videoToGif({ fps = 15, width = 540 } = {}): [
  ChildProcessWithoutNullStreams,
  Promise<Buffer>,
] {
  const ff = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    "pipe:0",
    "-vf",
    `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`,
    "-loop",
    "0",
    "-f",
    "gif",
    "pipe:1",
  ]);

  ff.stdin.on("error", () => {});

  const promise = new Promise<Buffer>((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];

    ff.stdout.on("data", (c: Buffer) => out.push(c));
    ff.stderr.on("data", (c: Buffer) => err.push(c));

    ff.on("error", reject);
    ff.on("close", (code, signal) => {
      if (code === 0) return resolve(Buffer.concat(out));
      const msg = Buffer.concat(err).toString().trim();
      reject(new Error(`ffmpeg exited ${code ?? signal}${msg ? `: ${msg}` : ""}`));
    });
  });

  return [ff, promise];
}
async function downloadToGIF(
  short: string,
  asset: InstagramAsset,
  carousel = false,
): Promise<Buffer[]> {
  if (asset.type == "carousel") {
    let res: Buffer[] = [];
    console.log(`[info] - ${short} - carousel: ${asset.assets.length} to go`);

    const downloads: Promise<any>[] = [];

    for (const ass of asset.assets) {
      console.log(
        `[info] - ${short} - ${ass.index + 1}/${asset.assets.length} (${ass.type}) downloading`,
      );
      downloads.push(
        downloadToGIF(short, ass, true).then((ass_data) => {
          if (ass_data) {
            res = res.concat(ass_data);
            console.log(
              `[info] - ${short} - ${ass.index + 1}/${asset.assets.length} (${ass.type}) done`,
            );
          } else {
            console.log(
              `[error] - ${short} - ${ass.index + 1}/${asset.assets.length} (${ass.type}) couldn't download`,
            );
          }
        }),
      );
    }
    await Promise.all(downloads);
    return res;
  }
  if (!carousel) console.log(`[info] - ${short} - (${asset.type}) downloading`);
  if (asset.type == "video") {
    const res = await fetch(asset.link);
    if (!res.ok) {
      console.log(`[error] - ${short} - couldn't download: ${res.status}`);
      return [];
    }
    const [child, promise] = videoToGif();
    try {
      await res.body?.pipeTo(Writable.toWeb(child.stdin));
      const ret = await promise;
      if (!carousel) console.log(`[info] - ${short} - (${asset.type}) downloaded`);
      return [ret];
    } catch (e) {
      console.log(`[error] - ${short} - ${e}`, (e as Error).stack);
    }
  }

  if (asset.type == "image") {
    const res = await fetch(asset.link);
    if (!res.ok) {
      console.log(`[error] - ${short} - couldn't download: ${res.status}`);
      return [];
    }
    const data = await res.arrayBuffer();
    try {
      return [
        await new Promise((resolve, reject) => {
          sharp(data)
            .resize({ width: 540 })
            .gif()
            .toBuffer((err, buffer, info) => {
              if (err != null) {
                console.log(`[error] - ${short} - couldn't convert image to gif: `, err, info);
                reject(err);
              } else {
                if (!carousel) console.log(`[info] - ${short} - (${asset.type}) downloaded`);
                resolve(buffer);
              }
            });
        }),
      ];
    } catch {
      return [];
    }
  }
  return [];
}

async function postToWebhook(data: Buffer, recipient: keyof typeof webhooks, name: string) {
  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({
      content: `for <@${recipient}>`,
      files: [{ id: 0, filename: name }],
    }),
  );
  form.append("files[0]", new Blob([Uint8Array.from(data)]), name);

  await fetch(webhooks[recipient], {
    method: "POST",
    body: form,
  });
}

async function handleEverything(shortcode: string, recipient: keyof typeof webhooks) {
  const ass = await getAssets(shortcode);
  if (!ass) return;
  const data = await downloadToGIF(shortcode, ass);
  let i = 1;
  const uploads: Promise<any>[] = [];
  for (const e of data) {
    console.log(`[info] - ${shortcode} - ${i}/${data.length} uploading to discord`);
    const ii = i;
    uploads.push(
      postToWebhook(e, recipient, `${shortcode}-${i++}.gif`).then(() => {
        console.log(`[info] - ${shortcode} - ${ii}/${data.length} uploaded to discord`);
      }),
    );
  }
}

app.post("/convert", async (c) => {
  const key = c.req.header("api-key");
  const data = users.get(key as string);
  if (data) {
    const url: string = (await c.req.json()).url.match(
      /https:\/\/www\.instagram\.com\/(?:reel|p)\/([a-zA-Z0-9-_]+)\/.*/,
    )[1];
    if (url) {
      void handleEverything(url, data);
    }
  }

  return c.text("ok!");
});
app.get("/", (c) => c.text(`meow :3`));

export default {
  port: PORT,
  fetch: app.fetch,
};
