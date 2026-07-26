// build.sbt for the rarebert Scala module.
// Pinned Scala/JDK versions match the devcontainer feature config.
ThisBuild / scalaVersion := "3.7.3"
ThisBuild / organization := "kn253"
ThisBuild / version      := "0.1.0"

lazy val root = (project in file("."))
  .settings(
    name := "rarebert-scala",
    libraryDependencies ++= Seq(
      "org.scalameta" %% "munit" % "1.0.2" % Test
    )
  )
