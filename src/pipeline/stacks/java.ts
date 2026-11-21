import { listNames, type Plan, WORKSPACE } from "../plan";
import type { Snapshot } from "../snapshot";
import type { RootLanguage } from "./stack";

/** What differs between the two build tools: file names, and how each spells "build" and "run the Spring Boot app". */
interface BuildTool {
  name: "Maven" | "Gradle";
  wrapper: string;
  bin: string;
  /** Builds every module; for Maven it also installs them, so one can then be run on its own. */
  buildAll: string;
  buildApp: string;
  runApp: string;
  runModule: (module: string) => string;
  /** The build file applies Spring Boot's plugin (or inherits it), which is what makes the project runnable. */
  appliesSpringBoot: RegExp;
}

const MAVEN: BuildTool = {
  name: "Maven",
  wrapper: "mvnw",
  bin: "mvn",
  buildAll: "-B -q -DskipTests install",
  buildApp: "-B -q -DskipTests package",
  runApp: "spring-boot:run",
  runModule: (module) => `-pl ${module} spring-boot:run`,
  appliesSpringBoot: /spring-boot-(starter-parent|maven-plugin)/,
};

const GRADLE: BuildTool = {
  name: "Gradle",
  wrapper: "gradlew",
  bin: "gradle",
  buildAll: "build -x test",
  buildApp: "build -x test",
  runApp: "bootRun",
  runModule: (module) => `:${module}:bootRun`,
  // The plugin id in quotes, as `id "…"`, `id("…")` and `apply plugin: "…"` write it; a dependency has a colon after it.
  appliesSpringBoot: /["']org\.springframework\.boot["']|spring-boot-gradle-plugin|plugins\.spring\.?boot/i,
};

const GRADLE_FILES = ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"];

/** The JDK a build file asks for (17, 21, …), or null when it names none Pyrovue can install. */
function javaVersion(build: string): string | null {
  const m =
    /<(?:java\.version|maven\.compiler\.(?:release|source|target))>\s*([\d.]+)\s*</.exec(build) ??
    /JavaLanguageVersion\.of\(\s*(\d+)\s*\)/.exec(build) ??
    /(?:source|target)Compatibility\s*=?\s*(?:JavaVersion\.VERSION_)?["']?([\d._]+)/.exec(build);
  // "1.8" and "1_8" are how Java 8 was written.
  const major = Number(m?.[1]?.replace(/^1[._]/, "").split(/[._]/)[0]);
  return major >= 8 && major <= 25 ? String(major) : null;
}

/** The modules one level down that hold a class named like a Spring Boot entry point (`…Application.java`). */
function applicationModules(files: Set<string>): string[] {
  const out: string[] = [];
  for (const f of files) {
    const module = /^([\w.-]+)\/src\/main\/(?:java|kotlin)\/.*Application\.(?:java|kt)$/.exec(f)?.[1];
    if (module && !out.includes(module)) out.push(module);
  }
  return out.sort();
}

/**
 * A Maven or Gradle project. Only a Spring Boot application gets a start command (`spring-boot:run` or `bootRun`,
 * through the repository's wrapper when it has one): the one at the root, when the root build file applies the Spring
 * Boot plugin, or the single application module of a multi-module build. A library that merely depends on Spring Boot
 * is built and left as a package, like any other, and an Android app is recognised and left alone.
 */
function detectJava(snapshot: Snapshot, files: Set<string>): Plan {
  const tool = files.has("pom.xml") ? MAVEN : GRADLE;
  const build = tool === MAVEN ? (snapshot.contents["pom.xml"] ?? "") : `${snapshot.contents["build.gradle"] ?? ""}\n${snapshot.contents["build.gradle.kts"] ?? ""}`;
  const wrapped = files.has(tool.wrapper);
  const run = wrapped ? `./${tool.wrapper}` : tool.bin;
  const version = javaVersion(build);
  const setup = [`mise use -g java@${version ? `temurin-${version}` : "21"}`];
  if (!wrapped) setup.push(`mise use -g ${tool.name.toLowerCase()}@latest`);
  const base = { env: {} as Record<string, string>, cwd: WORKSPACE, previewPath: null };
  const signature = (kind: string) => `java:${kind}:${tool.name.toLowerCase()}`;
  const springApp = { stack: ["Java", "Spring Boot", tool.name], kind: "web" as const, port: 8080, env: { SERVER_PORT: "8080" } };

  // An APK has no server to preview, and the box has no Android SDK to build it with.
  if (tool === GRADLE && (/com\.android\.|android[.-](application|library)/.test(build) || files.has("app/src/main/AndroidManifest.xml"))) {
    return {
      ...base,
      stack: ["Java", "Android", tool.name],
      kind: "unknown",
      summary: `Android app built with ${tool.name}.`,
      setup: [],
      start: null,
      port: null,
      confidence: "low",
      notes: ["This is an Android app: it builds an APK for a phone, so there is nothing to run or preview in the box."],
      signature: signature("android"),
    };
  }

  const sourcesAtRoot = [...files].some((f) => /^src\/main\/(java|kotlin)\//.test(f));
  if (sourcesAtRoot && tool.appliesSpringBoot.test(build)) {
    return {
      ...base,
      ...springApp,
      summary: `Spring Boot app built with ${tool.name}.`,
      setup: [...setup, `${run} ${tool.buildApp}`],
      start: `${run} ${tool.runApp}`,
      confidence: "medium",
      signature: signature("spring-boot"),
    };
  }
  // In a multi-module build the modules' own build files aren't read, so a module counts by its class name, and only
  // when the root build mentions Spring Boot at all.
  const apps = !sourcesAtRoot && /spring-boot|org\.springframework\.boot/.test(build) ? applicationModules(files) : [];
  if (apps.length === 1) {
    return {
      ...base,
      ...springApp,
      summary: `Spring Boot build with ${tool.name}; runs the ${apps[0]} module.`,
      setup: [...setup, `${run} ${tool.buildAll}`],
      start: `${run} ${tool.runModule(apps[0]!)}`,
      // Chosen by a file name, not by reading the class.
      confidence: "low",
      signature: signature("spring-boot"),
    };
  }
  if (apps.length > 1) {
    const n = apps.length;
    return {
      ...base,
      stack: springApp.stack,
      kind: "cli",
      summary: `Spring Boot build with ${n} applications (${listNames(apps)}).`,
      setup: [...setup, `${run} ${tool.buildAll}`],
      start: null,
      port: null,
      confidence: "low",
      notes: [`This build has ${n} Spring Boot applications, so Pyrovue does not pick one to start. It is built; start one with \`${run} ${tool.runModule(apps[0]!)}\` in the terminal.`],
      // Its own signature: what is learned from builds that start nothing mustn't count for the ones that start a server.
      signature: signature("spring-boot-multi"),
    };
  }
  // Gradle's java-library plugin is how a build says it publishes a library: on a single-project build, that is the
  // repository. A root build that hands the plugin to some subprojects says nothing about the whole (a broker, a
  // game). Nothing as plain exists for Maven, and "not Spring Boot" is no evidence either way: plenty of servers aren't.
  const singleProject = sourcesAtRoot && ![...files].some((f) => /^[^/]+\/build\.gradle(\.kts)?$/.test(f));
  const library = tool === GRADLE && singleProject && /java-library/.test(build) && !/\b(application|war)\b/.test(build);
  return {
    ...base,
    stack: ["Java", tool.name],
    kind: "cli",
    summary: `Java project built with ${tool.name}.`,
    setup: [...setup, `${run} ${tool.buildAll}`],
    start: null,
    port: null,
    confidence: "low",
    signature: signature(library ? "library" : "none"),
    ...(library ? { nothingToServe: "the java-library Gradle plugin and no application plugin" } : {}),
  };
}

export const JAVA: RootLanguage = {
  marks: (files) => files.has("pom.xml") || GRADLE_FILES.some((f) => files.has(f)),
  source: /\.(java|kt|scala|groovy)$/,
  detect: detectJava,
};
