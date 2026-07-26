package kn253

/** Main entry point for the rarebert TUI.
  *
  * The user is presented with a top-level menu that lets them choose between:
  *   1. Training a new model on the propaganda dataset.
  *   2. Loading a previously trained model and evaluating it.
  *   3. Exiting.
  *
  * All action methods are intentionally stubbed for now; the menu loop and
  * dispatch are fully implemented.
  */

import scala.annotation.tailrec
import scala.io.StdIn
import javax.swing.JFileChooser

/** Valid file extensions for dataset files */
val validFileEndings = List(".tsv", ".csv")

/** Top-level menu choices. */
enum MenuChoice(val key: String, val label: String, val description: String):
  case Train
      extends MenuChoice(
        "1",
        "Train a new model",
        "Run training on the propaganda dataset"
      )
  case Load
      extends MenuChoice(
        "2",
        "Load trained model",
        "Load a previously trained model and evaluate it"
      )
  case Exit extends MenuChoice("3", "Exit", "Quit the program")

object MenuChoice:
  /** Parse a single-key user selection into a [[MenuChoice]], if valid. */
  def fromKey(s: String): Option[MenuChoice] =
    MenuChoice.values.find(_.key == s.trim)

@main def entryPoint(): Unit =
  runMenuLoop()

/** Interactive read-eval-print loop that drives the menu. */
@tailrec
def runMenuLoop(): Unit =
  printMenu()
  val raw = StdIn.readLine("> Enter choice: ")
  val choice = MenuChoice.fromKey(raw)
  choice match
    case None =>
      println(s"[error] Unrecognized choice: '$raw'.  Please try again.")
      println()
      runMenuLoop()
    case Some(MenuChoice.Train) =>
      runTrainingFlow()
      runMenuLoop()
    case Some(MenuChoice.Load) =>
      runEvaluationFlow()
      runMenuLoop()
    case Some(MenuChoice.Exit) =>
      println("Goodbye.")
      // Tail recursion terminates the loop on exit.
      return

/** Print the top-level menu. */
def printMenu(): Unit =
  println("---- Main Menu ----")
  MenuChoice.values.foreach: c =>
    println(s"  [${c.key}] ${c.label}  -  ${c.description}")
  println()

/** Drive the "train a new model" flow.
  *
  * Stubbed for now: prompts for the dataset path and the destination model
  * path, then prints a placeholder message. Real implementation will load the
  * TSV via [[TrainingSet]] / [[ValueSet]], train, and persist the model.
  */
def runTrainingFlow(): Unit =
  println("[train] Starting training flow...")
  val datasetPath = promptForDatasetFile("Select training dataset file")
  val modelPath =
    promptNonEmpty("Path to write trained model", "models/rarebert.model")

  // Load and display the dataset
  try {
    val dataSet = DataSet.loadFromFile(datasetPath)
    val window = new DataSetWindow(dataSet)
    println(s"[train] dataset = $datasetPath")
    println(s"[train] model   = $modelPath")
    println("[train] (stub) training not yet implemented.")
  } catch {
    case e: Exception =>
      println(s"[error] Failed to load dataset: ${e.getMessage}")
  }

  println()

/** Drive the "load + evaluate" flow.
  *
  * Stubbed for now: prompts for the model path and the evaluation dataset, then
  * prints a placeholder message. Real implementation will deserialize the
  * model, run inference on the supplied dataset, and report metrics.
  */
def runEvaluationFlow(): Unit =
  println("[eval] Starting evaluation flow...")
  val modelPath =
    promptNonEmpty("Path to trained model", "models/rarebert.model")
  val datasetPath = promptForDatasetFile("Select evaluation dataset file")

  // Load and display the dataset
  try {
    val dataSet = DataSet.loadFromFile(datasetPath)
    val window = new DataSetWindow(dataSet)
    println(s"[eval] model   = $modelPath")
    println(s"[eval] dataset = $datasetPath")
    println("[eval] (stub) evaluation not yet implemented.")
  } catch {
    case e: Exception =>
      println(s"[error] Failed to load dataset: ${e.getMessage}")
  }

  println()

/** Prompt the user for input, falling back to `defaultValue` when the line is
  * blank. Repeats until a non-empty value is entered.
  */
@tailrec
def promptNonEmpty(label: String, defaultValue: String): String =
  val raw = StdIn.readLine(s"> $label [$defaultValue]: ")
  val value = if (raw == null || raw.trim.isEmpty) defaultValue else raw.trim
  if (value.isEmpty) then
    println("[error] value must not be empty.")
    promptNonEmpty(label, defaultValue)
  else value

/** Prompt the user for a dataset file path.
  *
  * This function creates a file selection dialog and returns the selected
  * file's absolute path.
  */
def promptForDatasetFile(title: String): String =
  val chooser = new JFileChooser()
  chooser.setDialogTitle(title)

  // Set default directory to the project root
  val projectDir = new java.io.File(".")
  if (projectDir.exists()) {
    chooser.setCurrentDirectory(projectDir)
  }

  // Add file filters for common dataset formats
  val filter = new javax.swing.filechooser.FileNameExtensionFilter(
    "TSV and CSV files",
    "tsv",
    "csv"
  )
  chooser.setFileFilter(filter)

  val result = chooser.showOpenDialog(null)
  if (result == JFileChooser.APPROVE_OPTION) {
    chooser.getSelectedFile.getAbsolutePath
  } else {
    println("[info] No file selected.")
    throw new RuntimeException("No dataset file selected")
  }
