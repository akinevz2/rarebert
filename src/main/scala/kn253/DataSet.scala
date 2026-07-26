package kn253

import scala.io.Source
import java.io.File
import javax.swing.{JFrame, JTextArea, JScrollPane, JLabel, JPanel}
import java.awt.{BorderLayout as AWTPanelLayout, Dimension}
import javax.swing.SwingConstants
import javax.swing.WindowConstants
import javax.swing.ScrollPaneConstants

/** Represents a dataset loaded from a TSV file.
  *
  * For now, this just loads the entire content into memory for display
  * purposes.
  */
private def loadContent(path: String): String = {
  try {
    val source = Source.fromFile(path)
    try {
      source.mkString
    } finally {
      source.close()
    }
  } catch {
    case _: Exception =>
      s"Error loading file $path. File not found or cannot be read."
  }
}
class DataSet(val filePath: String, val content: String) {
  def this(filePath: String) = {
    this(filePath, loadContent(filePath))
  }

  def size: Int = content.length

  override def toString: String = s"DataSet($filePath, ${size} chars)"
}

/** Window to display dataset content.
  */
class DataSetWindow(title: String, dataSet: DataSet) extends JFrame {
  def this(dataSet: DataSet) = {
    this(s"Dataset: ${dataSet.filePath}", dataSet)
  }

  // Set up the window
  setTitle(title)
  setDefaultCloseOperation(WindowConstants.DISPOSE_ON_CLOSE)
  setSize(800, 600)
  setLocationRelativeTo(null) // Center the window

  // Create text area with scroll pane
  val textArea = new JTextArea(dataSet.content)
  textArea.setEditable(false)
  textArea.setLineWrap(true)
  textArea.setWrapStyleWord(true)

  val scrollPane = new JScrollPane(textArea)
  scrollPane.setVerticalScrollBarPolicy(
    ScrollPaneConstants.VERTICAL_SCROLLBAR_ALWAYS
  )
  scrollPane.setHorizontalScrollBarPolicy(
    ScrollPaneConstants.HORIZONTAL_SCROLLBAR_AS_NEEDED
  )

  // Add components to window
  val contentPanel = new JPanel(new AWTPanelLayout())
  contentPanel.add(
    new JLabel(s"File: ${dataSet.filePath}"),
    AWTPanelLayout.NORTH
  )
  contentPanel.add(scrollPane, AWTPanelLayout.CENTER)

  add(contentPanel)

  setVisible(true)
}

object DataSet {
  def loadFromFile(filePath: String): DataSet = {
    new DataSet(filePath)
  }
}
