import { describe, expect, it } from "vitest";
import { detect, type Plan } from "../../src/pipeline/detect";
import { detectorTrust } from "../../src/pipeline/ranking";

const snap = (contents: Record<string, string>, extra: string[] = []) => ({ files: [...Object.keys(contents), ...extra], contents });
const all = (plan: Plan) => [plan, ...(plan.alternatives ?? [])];

const bootPom = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.4.1</version>
  </parent>
  <artifactId>petclinic</artifactId>
  <properties>
    <java.version>17</java.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
  </dependencies>
</project>
`;

describe("detect: Java", () => {
  it("starts a Spring Boot app built with Maven through its wrapper", () => {
    // spring-projects/spring-petclinic: one module, the application class under src/main/java.
    const plan = detect(snap({ "pom.xml": bootPom }, ["mvnw", "src/main/java/org/example/petclinic/PetClinicApplication.java", "src/main/resources/application.properties"]));
    expect(plan).toMatchObject({
      stack: ["Java", "Spring Boot", "Maven"],
      kind: "web",
      summary: "Spring Boot app built with Maven.",
      start: "./mvnw spring-boot:run",
      port: 8080,
      cwd: "/workspace",
      confidence: "medium",
      strategy: "framework",
      signature: "java:spring-boot:maven",
    });
    expect(plan.setup).toEqual(["mise use -g java@temurin-17", "./mvnw -B -q -DskipTests package"]);
    // Spring reads its port from SERVER_PORT.
    expect(plan.env.SERVER_PORT).toBe("8080");
    // Evidence from manifests alone does not send the detector ahead of the agent.
    expect(detectorTrust(plan)).toBeLessThan(0.75);
  });

  it("starts a Spring Boot app built with Gradle, with or without a wrapper", () => {
    const gradle = 'plugins {\n  java\n  id("org.springframework.boot") version "3.4.1"\n}\n\njava {\n  toolchain {\n    languageVersion = JavaLanguageVersion.of(21)\n  }\n}\n';
    const wrapped = detect(snap({ "build.gradle.kts": gradle }, ["gradlew", "settings.gradle.kts", "src/main/kotlin/com/example/DemoApplication.kt"]));
    expect(wrapped).toMatchObject({ start: "./gradlew bootRun", port: 8080, kind: "web", signature: "java:spring-boot:gradle" });
    expect(wrapped.setup).toEqual(["mise use -g java@temurin-21", "./gradlew build -x test"]);
    const bare = detect(snap({ "build.gradle.kts": gradle }, ["src/main/java/com/example/DemoApplication.java"]));
    expect(bare.start).toBe("gradle bootRun");
    expect(bare.setup).toEqual(["mise use -g java@temurin-21", "mise use -g gradle@latest", "gradle build -x test"]);
  });

  it("builds a library without proposing a start command", () => {
    // google/guava: a multi-module Maven build with nothing to run.
    const pom = "<project>\n  <artifactId>guava-parent</artifactId>\n  <packaging>pom</packaging>\n  <modules>\n    <module>guava</module>\n    <module>guava-testlib</module>\n  </modules>\n  <properties>\n    <maven.compiler.release>11</maven.compiler.release>\n  </properties>\n</project>\n";
    const plan = detect(snap({ "pom.xml": pom }, ["mvnw", "guava/pom.xml", "guava/src/com/google/common/base/Optional.java", "guava-testlib/pom.xml"]));
    expect(plan).toMatchObject({ stack: ["Java", "Maven"], kind: "cli", start: null, port: null, summary: "Java project built with Maven.", confidence: "low", signature: "java:none:maven" });
    expect(plan.setup).toEqual(["mise use -g java@temurin-11", "./mvnw -B -q -DskipTests install"]);
  });

  it("doesn't start a Java program that isn't a Spring Boot app", () => {
    // TheAlgorithms/Java: one Maven module of classes with nothing listening on a port.
    const plan = detect(snap({ "pom.xml": "<project><artifactId>Java</artifactId><packaging>jar</packaging></project>" }, ["src/main/java/com/thealgorithms/sorts/QuickSort.java", "src/test/java/com/thealgorithms/sorts/QuickSortTest.java"]));
    expect(plan).toMatchObject({ kind: "cli", start: null, signature: "java:none:maven" });
  });

  it("doesn't start a library that only depends on Spring Boot", () => {
    // A starter or an auto-configuration: Spring Boot is on the classpath, but no plugin makes the jar runnable.
    const pom = "<project>\n  <artifactId>acme-spring-boot-starter</artifactId>\n  <dependencies>\n    <dependency>\n      <groupId>org.springframework.boot</groupId>\n      <artifactId>spring-boot-autoconfigure</artifactId>\n    </dependency>\n    <dependency>\n      <groupId>org.springframework.boot</groupId>\n      <artifactId>spring-boot-starter-test</artifactId>\n      <scope>test</scope>\n    </dependency>\n  </dependencies>\n</project>\n";
    const maven = detect(snap({ "pom.xml": pom }, ["src/main/java/com/acme/AcmeAutoConfiguration.java"]));
    expect(maven).toMatchObject({ kind: "cli", start: null, signature: "java:none:maven" });
    const gradle = detect(snap({ "build.gradle": "plugins { id 'java-library' }\ndependencies {\n  api 'org.springframework.boot:spring-boot-autoconfigure:3.4.1'\n}\n" }, ["src/main/java/com/acme/AcmeAutoConfiguration.java"]));
    expect(gradle).toMatchObject({ kind: "cli", start: null, signature: "java:library:gradle" });
  });

  it("reads the Java version however the build file writes it, and falls back to 21", () => {
    const java = (build: Record<string, string>) => detect(snap(build, ["src/main/java/App.java"])).setup[0];
    expect(java({ "pom.xml": "<project><properties><maven.compiler.source>1.8</maven.compiler.source></properties></project>" })).toBe("mise use -g java@temurin-8");
    expect(java({ "build.gradle": "sourceCompatibility = JavaVersion.VERSION_17\n" })).toBe("mise use -g java@temurin-17");
    expect(java({ "build.gradle": "sourceCompatibility = '11'\n" })).toBe("mise use -g java@temurin-11");
    expect(java({ "pom.xml": "<project><properties><java.version>${revision}</java.version></properties></project>" })).toBe("mise use -g java@21");
    expect(java({ "build.gradle": "plugins { id 'java' }\n" })).toBe("mise use -g java@21");
  });

  it("recognises an Android app and proposes nothing to run", () => {
    // TeamNewPipe/NewPipe: Gradle builds an APK; there is no server and no SDK in the box.
    const plan = detect(snap({ "build.gradle.kts": 'plugins {\n  alias(libs.plugins.android.application) apply false\n  alias(libs.plugins.jetbrains.kotlin.android) apply false\n}\n' }, ["gradlew", "settings.gradle.kts", "app/build.gradle.kts", "app/src/main/AndroidManifest.xml", "app/src/main/java/org/schabi/newpipe/App.kt"]));
    expect(plan).toMatchObject({ stack: ["Java", "Android", "Gradle"], kind: "unknown", setup: [], start: null, port: null, signature: "java:android:gradle", confidence: "low" });
    expect(plan.summary).toBe("Android app built with Gradle.");
    expect(plan.notes?.[0]).toMatch(/Android app/);
    // An Android manifest alone says so too, whatever the root build file looks like.
    const byManifest = detect(snap({ "build.gradle": "buildscript {\n  repositories { google() }\n}\n" }, ["gradlew", "app/src/main/AndroidManifest.xml", "app/src/main/java/com/example/MainActivity.java"]));
    expect(byManifest.signature).toBe("java:android:gradle");
  });

  const parentPom = (modules: string[]) =>
    `<project>\n  <parent>\n    <groupId>org.springframework.boot</groupId>\n    <artifactId>spring-boot-starter-parent</artifactId>\n  </parent>\n  <packaging>pom</packaging>\n  <modules>\n${modules.map((m) => `    <module>${m}</module>`).join("\n")}\n  </modules>\n</project>\n`;

  it("runs the one application module of a multi-module Spring Boot build", () => {
    // xuxueli/xxl-job: xxl-job-core is a library, xxl-job-admin the server.
    const plan = detect(
      snap({ "pom.xml": parentPom(["xxl-job-core", "xxl-job-admin"]) }, ["xxl-job-core/pom.xml", "xxl-job-core/src/main/java/com/xxl/job/core/executor/XxlJobExecutor.java", "xxl-job-admin/pom.xml", "xxl-job-admin/src/main/java/com/xxl/job/admin/XxlJobAdminApplication.java"]),
    );
    expect(plan).toMatchObject({ kind: "web", start: "mvn -pl xxl-job-admin spring-boot:run", port: 8080, signature: "java:spring-boot:maven", summary: "Spring Boot build with Maven; runs the xxl-job-admin module." });
    expect(plan.setup).toEqual(["mise use -g java@21", "mise use -g maven@latest", "mvn -B -q -DskipTests install"]);
    // Picked by a file name, so it is a guess.
    expect(plan.confidence).toBe("low");
  });

  it("runs the one application module of a Gradle build by its project path", () => {
    const plan = detect(snap({ "build.gradle": "plugins {\n  id 'org.springframework.boot' version '3.4.1' apply false\n}\n" }, ["gradlew", "settings.gradle", "api/build.gradle", "api/src/main/java/run/halo/app/Application.java", "platform/build.gradle"]));
    expect(plan).toMatchObject({ start: "./gradlew :api:bootRun", port: 8080, confidence: "low", summary: "Spring Boot build with Gradle; runs the api module." });
  });

  it("only builds a Spring Boot build with several applications, and says which", () => {
    // macrozheng/mall: admin, portal and search are three servers; choosing one would be a coin toss.
    const plan = detect(
      snap(
        { "pom.xml": parentPom(["mall-common", "mall-admin", "mall-portal", "mall-search"]) },
        ["mall-common/src/main/java/com/macro/mall/common/api/CommonResult.java", "mall-admin/src/main/java/com/macro/mall/MallAdminApplication.java", "mall-portal/src/main/java/com/macro/mall/portal/MallPortalApplication.java", "mall-search/src/main/java/com/macro/mall/search/MallSearchApplication.java"],
      ),
    );
    expect(plan).toMatchObject({ kind: "cli", start: null, port: null, signature: "java:spring-boot-multi:maven", confidence: "low" });
    expect(plan.summary).toBe("Spring Boot build with 3 applications (mall-admin, mall-portal and mall-search).");
    expect(plan.notes?.[0]).toBe("This build has 3 Spring Boot applications, so Pyrovue does not pick one to start. It is built; start one with `mvn -pl mall-admin spring-boot:run` in the terminal.");
  });
});

describe("detect: Java next to other languages", () => {
  const vite = JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "6" } });

  it("runs a Spring Boot server with its ui/ dev server in front", () => {
    const plan = detect(snap({ "pom.xml": bootPom, "ui/package.json": vite }, ["mvnw", "src/main/java/io/example/Application.java", "src/main/java/io/example/api/FlowController.java", "ui/src/main.ts"]));
    expect(plan).toMatchObject({ strategy: "framework:both", signature: "java:spring-boot:maven", cwd: "/workspace/ui", port: 5173 });
    expect(plan.start).toBe("(cd /workspace && PORT=8080 ./mvnw spring-boot:run) & npm run dev");
    expect(plan.services).toEqual([{ name: "Spring Boot in the repo root", cwd: "/workspace", command: "./mvnw spring-boot:run", port: 8080, portGuessed: true }]);
    expect(all(plan).find((p) => p.strategy === "framework")).toMatchObject({ cwd: "/workspace", start: "./mvnw spring-boot:run" });
    // Spring still listens where the service says, behind the dev server.
    expect(plan.env).toMatchObject({ SERVER_PORT: "8080", PORT: "5173" });
  });

  it("reads a Java project with a tooling package.json at the root as Java", () => {
    const plan = detect(snap({ "pom.xml": "<project><artifactId>lib</artifactId></project>", "package.json": JSON.stringify({ private: true, devDependencies: { prettier: "^3", "prettier-plugin-java": "^2" } }) }, ["src/main/java/com/example/Lib.java", "src/test/java/com/example/LibTest.java"]));
    expect(plan.signature).toBe("java:none:maven");
    expect(plan.setup.join("\n")).not.toMatch(/\bnpm\b/);
  });

  it("keeps a JavaScript app with a small Gradle module beside it as Node.js", () => {
    // A React Native style layout: the app starts from package.json; Gradle only builds the Android shell.
    const plan = detect(snap({ "package.json": JSON.stringify({ scripts: { start: "expo start", dev: "vite" }, devDependencies: { vite: "6" } }), "build.gradle": "buildscript {}\n" }, ["src/App.tsx", "src/index.ts", "android/app/src/main/java/com/app/MainActivity.java"]));
    expect(plan.signature).toBe("node:vite:npm");
  });
});
